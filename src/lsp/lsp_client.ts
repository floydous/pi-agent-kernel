import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type LspRequest,
  type LspNotification,
  type LspClientState,
  type LspDiagnostic,
  type LspLocation,
  type LspHover,
  type LspDocumentSymbol,
  type LspSymbolInformation,
} from "./lsp_types";
import { pathToUri, normalizeLocations } from "./lsp_formatter";
import { kernelDebug } from "../safety/kernel_debug";
import { loadKernelConfig } from "../config";

export interface StdioLspClientOptions {
  command: string;
  args: string[];
  cwd: string;
  languageId: string;
  env?: Record<string, string>;
  idleTimeoutMs?: number;
}

export class StdioLspClient {
  public readonly id: string;
  public readonly languageId: string;
  public readonly rootDir: string;
  private options: StdioLspClientOptions;

  private process: ChildProcess | null = null;
  private state: LspClientState = "stopped";
  private nextRequestId = 1;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (res: any) => void;
      reject: (err: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffer = Buffer.alloc(0);
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private diagnosticListeners = new Map<string, Array<(diags: LspDiagnostic[]) => void>>();
  private openDocuments = new Map<string, { version: number; text: string }>();
  private lastActivityTime = Date.now();
  private serverCapabilities: any = {};

  constructor(id: string, options: StdioLspClientOptions) {
    this.id = id;
    this.languageId = options.languageId;
    this.rootDir = options.cwd;
    this.options = options;
  }

  public getState(): LspClientState {
    return this.state;
  }

  public getLastActivity(): number {
    return this.lastActivityTime;
  }

  public touch(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Start server process and perform two-phase LSP handshake (initialize -> initialized)
   */
  public async start(): Promise<boolean> {
    if (this.state === "ready" || this.state === "starting") return true;

    this.state = "starting";
    this.touch();

    try {
      this.process = spawn(this.options.command, this.options.args, {
        cwd: this.rootDir,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        this.onData(chunk);
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        // Silently ignore server stderr or log if needed
      });

      this.process.on("error", (err) => {
        this.state = "error";
      });

      this.process.on("exit", () => {
        this.state = "stopped";
        this.cleanupPending(new Error("LSP server process exited"));
      });

      // Handshake Phase 1: initialize
      const rootUri = pathToUri(this.rootDir);
      const initResult = await this.sendRequest<any>(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          rootPath: this.rootDir,
          workspaceFolders: [{ uri: rootUri, name: "workspace" }],
          capabilities: {
            workspace: {
              workspaceFolders: true,
              configuration: true,
            },
            textDocument: {
              synchronization: {
                dynamicRegistration: false,
                willSave: false,
                willSaveWaitUntil: false,
                didSave: true,
              },
              publishDiagnostics: {
                relatedInformation: true,
                versionSupport: true,
              },
              hover: {
                contentFormat: ["markdown", "plaintext"],
              },
              definition: {
                linkSupport: true,
              },
              references: {},
              documentSymbol: {
                hierarchicalDocumentSymbolSupport: true,
              },
              diagnostic: {
                dynamicRegistration: false,
              },
            },
          },
          initializationOptions: {},
        },
        5000,
      );

      this.serverCapabilities = initResult?.capabilities || {};

      // Handshake Phase 2: initialized notification
      this.sendNotification("initialized", {});
      this.state = "ready";
      return true;
    } catch (err) {
      this.state = "error";
      this.stop();
      return false;
    }
  }

  /**
   * Handle incoming stdout bytes (stdio framing: Content-Length: ...\r\n\r\n{JSON})
   */
  private onData(chunk: Buffer): void {
    this.touch();
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEndIndex = this.buffer.indexOf("\r\n\r\n");
      if (headerEndIndex === -1) break;

      const headerText = this.buffer
        .subarray(0, headerEndIndex)
        .toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Corrupted header, skip past \r\n\r\n
        this.buffer = this.buffer.subarray(headerEndIndex + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStartIndex = headerEndIndex + 4;
      const totalMessageLength = bodyStartIndex + contentLength;

      if (this.buffer.length < totalMessageLength) {
        // Incomplete body, wait for next data chunk
        break;
      }

      const bodyBuffer = this.buffer.subarray(
        bodyStartIndex,
        totalMessageLength,
      );
      this.buffer = this.buffer.subarray(totalMessageLength);

      try {
        const messageJson = JSON.parse(bodyBuffer.toString("utf8"));
        this.handleMessage(messageJson);
      } catch (e) {
        kernelDebug(e);
      }
    }
  }

  /**
   * Dispatch parsed JSON-RPC message
   */
  private handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      // It's a response to a request
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!;
      clearTimeout(timer);
      this.pendingRequests.delete(msg.id);

      if (msg.error) {
        reject(new Error(msg.error.message || `LSP Error ${msg.error.code}`));
      } else {
        resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      // Servers may issue JSON-RPC requests of their own (most notably
      // workspace/configuration). Replying is required or the server can stop
      // processing subsequent document requests while waiting indefinitely.
      if (msg.id !== undefined) {
        this.handleServerRequest(msg);
      } else {
        this.handleNotification(msg);
      }
    }
  }

  /** Reply to server-initiated JSON-RPC requests with minimal safe defaults. */
  private handleServerRequest(request: { id: number | string; method: string; params?: any }): void {
    let result: any = null;
    switch (request.method) {
      case "workspace/configuration":
        result = Array.isArray(request.params?.items)
          ? request.params.items.map(() => null)
          : [];
        break;
      case "workspace/workspaceFolders":
        result = [
          {
            uri: pathToUri(this.rootDir),
            name: path.basename(this.rootDir),
          },
        ];
        break;
      case "workspace/applyEdit":
        result = { applied: false };
        break;
      // Capability registration, progress creation, and unrecognised optional
      // requests are acknowledged with JSON-RPC null so they cannot deadlock
      // the server's request queue.
    }
    this.sendRaw({ jsonrpc: "2.0", id: request.id, result });
  }

  /**
   * Handle incoming notifications (e.g. textDocument/publishDiagnostics)
   */
  private handleNotification(notif: LspNotification): void {
    if (notif.method === "textDocument/publishDiagnostics") {
      const uri = notif.params?.uri;
      const diagnostics = notif.params?.diagnostics || [];
      if (uri) {
        this.diagnosticsCache.set(uri, diagnostics);
        const listeners = this.diagnosticListeners.get(uri);
        if (listeners && listeners.length > 0) {
          this.diagnosticListeners.delete(uri);
          for (const listener of listeners) {
            try {
              listener(diagnostics);
            } catch (e) {
              kernelDebug(e);
            }
          }
        }
      }
    }
  }

  /**
   * Send JSON-RPC Request with timeout
   */
  public sendRequest<T = any>(
    method: string,
    params?: any,
    timeoutMs = 4000,
  ): Promise<T> {
    this.touch();
    const id = this.nextRequestId++;
    const payload: LspRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(
            new Error(`LSP Request '${method}' timed out after ${timeoutMs}ms`),
          );
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendRaw(payload);
    });
  }

  /**
   * Send JSON-RPC Notification (fire-and-forget)
   */
  public sendNotification(method: string, params?: any): void {
    this.touch();
    const payload: LspNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.sendRaw(payload);
  }

  private sendRaw(obj: any): void {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
      return;
    }
    const jsonStr = JSON.stringify(obj);
    const byteLength = Buffer.byteLength(jsonStr, "utf8");
    const frame = `Content-Length: ${byteLength}\r\n\r\n${jsonStr}`;
    try {
      this.process.stdin.write(frame);
    } catch (e) {
      kernelDebug(e);
    }
  }

  /**
   * Open document in LSP buffer tracking
   */
  public async openDocument(filePath: string, content?: string): Promise<void> {
    const uri = pathToUri(filePath);
    const text =
      content === undefined
        ? fs.existsSync(filePath)
          ? fs.readFileSync(filePath, "utf8")
          : ""
        : content;

    if (this.openDocuments.has(uri)) {
      await this.changeDocument(filePath, text);
      return;
    }

    this.openDocuments.set(uri, { version: 1, text });
    this.diagnosticsCache.delete(uri);
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.languageId,
        version: 1,
        text,
      },
    });
  }

  /**
   * Send document change notification
   */
  public async changeDocument(filePath: string, text: string): Promise<void> {
    const uri = pathToUri(filePath);
    const existing = this.openDocuments.get(uri);
    const version = (existing?.version || 0) + 1;
    this.openDocuments.set(uri, { version, text });
    this.diagnosticsCache.delete(uri);

    this.sendNotification("textDocument/didChange", {
      textDocument: {
        uri,
        version,
      },
      contentChanges: [{ text }],
    });
  }

  /**
   * Send document saved notification
   */
  public async saveDocument(filePath: string, text?: string): Promise<void> {
    const uri = pathToUri(filePath);
    this.sendNotification("textDocument/didSave", {
      textDocument: { uri },
      text,
    });
  }

  /**
   * Wait for a push diagnostic notification event for a specific document URI.
   */
  private waitForPushDiagnostics(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onArrived = (diags: LspDiagnostic[]) => {
        if (timer) clearTimeout(timer);
        resolve(diags);
      };

      timer = setTimeout(() => {
        const listeners = this.diagnosticListeners.get(uri) || [];
        const filtered = listeners.filter((l) => l !== onArrived);
        if (filtered.length > 0) {
          this.diagnosticListeners.set(uri, filtered);
        } else {
          this.diagnosticListeners.delete(uri);
        }
        resolve(null);
      }, timeoutMs);

      const listeners = this.diagnosticListeners.get(uri) || [];
      listeners.push(onArrived);
      this.diagnosticListeners.set(uri, listeners);
    });
  }

  /**
   * Get diagnostics with an explicit uncertainty status.
   * An empty result is only clean when the server positively reported it.
   */
  public async getDiagnosticsResult(filePath: string, timeoutMsOverride?: number): Promise<{
    status: "clean" | "findings" | "timeout" | "inconclusive";
    diagnostics: LspDiagnostic[];
  }> {
    const uri = pathToUri(filePath);
    await this.openDocument(filePath);

    // If push diagnostics were already published and cached, return them immediately.
    if (this.diagnosticsCache.has(uri)) {
      const cached = this.diagnosticsCache.get(uri) || [];
      return {
        status: cached.length > 0 ? "findings" : "clean",
        diagnostics: cached,
      };
    }

    const config = loadKernelConfig();
    const timeoutMs = timeoutMsOverride ?? config.lsp.diagnostic_timeout_ms ?? 4000;

    // Pull diagnostics are optional in LSP 3.17.
    if (this.serverCapabilities.diagnosticProvider) {
      try {
        const pullRes = await this.sendRequest<any>(
          "textDocument/diagnostic",
          {
            textDocument: { uri },
          },
          timeoutMs,
        );
        if (pullRes?.items && Array.isArray(pullRes.items)) {
          this.diagnosticsCache.set(uri, pullRes.items);
          return {
            status: pullRes.items.length > 0 ? "findings" : "clean",
            diagnostics: pullRes.items,
          };
        }
      } catch (e) {
        kernelDebug(e);
        const message = e instanceof Error ? e.message : String(e);
        // Method-not-found / unsupported pull is not a failed diagnostic run;
        // continue to the push-diagnostic event wait below.
        if (message.includes("timed out")) {
          // If pull timed out but push cache arrived, prefer cache
          if (this.diagnosticsCache.has(uri)) {
            const cached = this.diagnosticsCache.get(uri) || [];
            return {
              status: cached.length > 0 ? "findings" : "clean",
              diagnostics: cached,
            };
          }
          return { status: "timeout", diagnostics: [] };
        }
      }
    }

    // Push-only servers emit textDocument/publishDiagnostics after didOpen/didChange.
    // Event-driven wait: resolves as soon as the server publishes without sleep polling.
    const pushResult = await this.waitForPushDiagnostics(uri, timeoutMs);
    if (pushResult === null) {
      return { status: "inconclusive", diagnostics: [] };
    }
    return {
      status: pushResult.length > 0 ? "findings" : "clean",
      diagnostics: pushResult,
    };
  }

  /**
   * Backward-compatible diagnostics accessor for the LSP tool.
   */
  public async getDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
    const result = await this.getDiagnosticsResult(filePath);
    return result.diagnostics;
  }

  /**
   * Jump to Definition
   */
  public async gotoDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    const uri = pathToUri(filePath);
    await this.openDocument(filePath);

    try {
      const res = await this.sendRequest<any>("textDocument/definition", {
        textDocument: { uri },
        position: { line, character },
      });
      return normalizeLocations(res);
    } catch {
      return [];
    }
  }

  /**
   * Find References
   */
  public async findReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    const uri = pathToUri(filePath);
    await this.openDocument(filePath);

    try {
      const res = await this.sendRequest<any>("textDocument/references", {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration: true },
      });
      return normalizeLocations(res);
    } catch {
      return [];
    }
  }

  /**
   * Hover (Type information / Docstrings)
   */
  public async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspHover | null> {
    const uri = pathToUri(filePath);
    await this.openDocument(filePath);

    try {
      return await this.sendRequest<LspHover>("textDocument/hover", {
        textDocument: { uri },
        position: { line, character },
      });
    } catch {
      return null;
    }
  }

  /**
   * Document Symbols
   */
  public async documentSymbol(
    filePath: string,
  ): Promise<(LspDocumentSymbol | LspSymbolInformation)[]> {
    const uri = pathToUri(filePath);
    await this.openDocument(filePath);

    try {
      const res = await this.sendRequest<any>("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }

  /**
   * Graceful shutdown and termination
   */
  public async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "shutting_down";

    try {
      if (this.process && !this.process.killed) {
        await Promise.race([
          this.sendRequest("shutdown", undefined, 1000).then(() => {
            this.sendNotification("exit");
          }),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
        this.process.kill();
      }
    } catch (e) {
      kernelDebug(e);
    }

    this.state = "stopped";
    this.process = null;
    this.cleanupPending(new Error("LSP client stopped"));
  }

  private cleanupPending(err: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }
}
