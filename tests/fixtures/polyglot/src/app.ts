// TypeScript fixture: server with multiple classes, generics, decorators, complex signatures.
import { EventEmitter } from "node:events";

export interface DatabaseOptions {
    host: string;
    port: number;
    ssl?: boolean;
    poolSize?: number;
    connectionTimeoutMs?: number;
}

export interface ServerStats {
    totalRequests: number;
    activeConnections: number;
    errorCount: number;
    lastRestartedAt: Date | null;
}

/**
 * A connection pool with health-check, auto-reconnect, and metrics reporting.
 */
export abstract class BaseConnection<T> {
    protected abstract connectInternal(): Promise<T>;
    public abstract ping(): boolean;
    public abstract get endpoint(): string;

    public async withConnection<R>(work: (c: T) => Promise<R>): Promise<R> {
        const conn = await this.connectInternal();
        try {
            return await work(conn);
        } finally {
            this.release();
        }
    }

    protected abstract release(): void;
}

export class PostgresPool extends BaseConnection<object> {
    private static readonly DEFAULT_POOL_SIZE = 10;
    private poolSize: number;
    private _active: boolean = false;
    private _endpoint: string;

    constructor(private readonly options: DatabaseOptions) {
        super();
        this.poolSize = options.poolSize ?? PostgresPool.DEFAULT_POOL_SIZE;
        this._endpoint = `${options.host}:${options.port}`;
    }

    public get endpoint(): string {
        return this._endpoint;
    }

    public get isActive(): boolean {
        return this._active;
    }

    protected async connectInternal(): Promise<object> {
        return { connected: true, host: this.options.host };
    }

    public ping(): boolean {
        return this._active && this.poolSize > 0;
    }

    protected release(): void {
        this._active = false;
    }

    public static createDefault(): PostgresPool {
        return new PostgresPool({ host: "localhost", port: 5432, ssl: false });
    }

    public async runMigrations(): Promise<void> {
        // Migration placeholder — production code calls sql files here.
        await Promise.resolve();
    }
}

export class AppServer extends EventEmitter {
    private stats: ServerStats = {
        totalRequests: 0,
        activeConnections: 0,
        errorCount: 0,
        lastRestartedAt: null,
    };
    private readonly pool: BaseConnection<object>;

    constructor(pool: BaseConnection<object>) {
        super();
        this.pool = pool;
    }

    public async start(cfg: DatabaseOptions): Promise<void> {
        await this.pool.withConnection(async () => {
            // Initialize on first connection.
        });
        this.stats.lastRestartedAt = new Date();
        this.emit("started", cfg);
    }

    public async handleRequest<T>(req: T): Promise<{ ok: boolean; data?: unknown }> {
        this.stats.totalRequests += 1;
        this.stats.activeConnections += 1;
        try {
            if (!this.pool.ping()) {
                return { ok: false };
            }
            return { ok: true, data: req };
        } catch (err) {
            this.stats.errorCount += 1;
            throw err;
        } finally {
            this.stats.activeConnections -= 1;
        }
    }

    public getStats(): Readonly<ServerStats> {
        return Object.freeze({ ...this.stats });
    }
}
