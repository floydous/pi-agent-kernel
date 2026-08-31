import * as path from "node:path";
import { StdioLspClient } from "./lsp_client";
import { resolveLspServer } from "./lsp_registry";
import { detectLanguageFromPath, findWorkspaceRoot } from "./lsp_detector";
import { loadKernelConfig } from "../config";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class LspManager {
  private static instance: LspManager | null = null;
  private clients = new Map<string, StdioLspClient>();
  private reaperTimer: NodeJS.Timeout | null = null;

  public static getInstance(): LspManager {
    if (!LspManager.instance) {
      LspManager.instance = new LspManager();
    }
    return LspManager.instance;
  }

  constructor() {
    this.startReaper();
  }

  /**
   * Start periodic reaper to clean up idle LSP servers (every 60s)
   */
  private startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      this.reapIdleClients(loadKernelConfig().lsp.idle_timeout_ms);
    }, 60 * 1000);
    if (this.reaperTimer.unref) {
      this.reaperTimer.unref();
    }
  }

  /**
   * Stop reaper timer
   */
  public stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /**
   * Reap clients that have been idle past DEFAULT_IDLE_TIMEOUT_MS
   */
  public async reapIdleClients(
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  ): Promise<void> {
    const now = Date.now();
    for (const [id, client] of this.clients.entries()) {
      if (now - client.getLastActivity() > idleTimeoutMs) {
        await client.stop();
        this.clients.delete(id);
      }
    }
  }

  /**
   * Return a ready client without spawning a language server.
   * Used by bounded verification paths where startup latency is undesirable.
   */
  public getReadyClientForFile(
    filePath: string,
    cwd: string,
  ): StdioLspClient | null {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);
    const langKey = detectLanguageFromPath(absPath);
    if (!langKey) return null;

    const rootDir = findWorkspaceRoot(path.dirname(absPath), langKey);
    const client = this.clients.get(`${langKey}:${rootDir}`);
    if (!client || client.getState() !== "ready") return null;
    client.touch();
    return client;
  }

  /**
   * Get or spawn an active LSP client for a target file
   */
  public async getClientForFile(
    filePath: string,
    cwd: string,
  ): Promise<StdioLspClient | null> {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);
    const langKey = detectLanguageFromPath(absPath);
    if (!langKey) return null;

    const rootDir = findWorkspaceRoot(path.dirname(absPath), langKey);
    const clientId = `${langKey}:${rootDir}`;

    const existing = this.clients.get(clientId);
    if (existing) {
      if (existing.getState() === "ready") {
        existing.touch();
        return existing;
      }
      // If client is in error or stopped state, clean it up before recreating
      await existing.stop().catch(() => {});
      this.clients.delete(clientId);
    }

    // Resolve installed executable
    const resolved = resolveLspServer(langKey);
    if (!resolved) return null;

    const client = new StdioLspClient(clientId, {
      command: resolved.binPath,
      args: resolved.args,
      cwd: rootDir,
      languageId: resolved.languageId,
    });

    const started = await client.start();
    if (started) {
      this.clients.set(clientId, client);
      return client;
    }

    return null;
  }

  /**
   * Get all active clients status
   */
  public getStatus(): Array<{
    id: string;
    languageId: string;
    rootDir: string;
    state: string;
    idleSeconds: number;
  }> {
    const now = Date.now();
    const list: Array<{
      id: string;
      languageId: string;
      rootDir: string;
      state: string;
      idleSeconds: number;
    }> = [];
    for (const [id, client] of this.clients.entries()) {
      list.push({
        id,
        languageId: client.languageId,
        rootDir: client.rootDir,
        state: client.getState(),
        idleSeconds: Math.floor((now - client.getLastActivity()) / 1000),
      });
    }
    return list;
  }

  /**
   * Stop all active servers for a specific language
   */
  public async stopLanguage(languageOrKey: string): Promise<void> {
    const norm = languageOrKey.toLowerCase();
    for (const [id, client] of this.clients.entries()) {
      if (
        client.languageId.toLowerCase() === norm ||
        id.startsWith(norm + ":")
      ) {
        await client.stop();
        this.clients.delete(id);
      }
    }
  }

  /**
   * Stop all active servers
   */
  public async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
  }
}
