export interface ServerConfig {
    port: number;
    host: string;
}

export class AppServer {
    private _active: boolean = false;

    get isActive(): boolean {
        return this._active;
    }

    public async start(cfg: ServerConfig): Promise<void> {
        this._active = true;
    }
}
