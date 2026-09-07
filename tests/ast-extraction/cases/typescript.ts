export const TS_COMPLEX_CODE = `
import { BaseConfig } from "./base";

export interface DatabaseOptions {
    host: string;
    port: number;
    ssl?: boolean;
}

export abstract class BaseConnection<T> {
    protected abstract connectInternal(): Promise<T>;
    public abstract ping(): boolean;
}

export class PostgresPool extends BaseConnection<object> {
    private poolSize: number;

    constructor(private readonly options: DatabaseOptions) {
        super();
        this.poolSize = 10;
    }

    get isReady(): boolean {
        return this.poolSize > 0;
    }

    protected async connectInternal(): Promise<object> {
        return { connected: true };
    }

    public ping(): boolean {
        return true;
    }

    public static createDefault(): PostgresPool {
        return new PostgresPool({ host: "localhost", port: 5432 });
    }
}
`;
