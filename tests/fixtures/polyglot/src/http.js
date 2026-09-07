// JavaScript fixture: real-world service with classes and async patterns.

const EventEmitter = require("node:events");

class Cache {
    constructor(maxEntries = 1000) {
        this.store = new Map();
        this.maxEntries = maxEntries;
    }

    get(key) {
        return this.store.has(key) ? this.store.get(key) : undefined;
    }

    set(key, value, ttlMs = 3600000) {
        if (this.store.size >= this.maxEntries) {
            const firstKey = this.store.keys().next().value;
            this.store.delete(firstKey);
        }
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    }

    delete(key) {
        return this.store.delete(key);
    }
}

class HttpService extends EventEmitter {
    constructor(baseUrl) {
        super();
        this.baseUrl = baseUrl;
        this.cache = new Cache();
    }

    async fetchJson(path, options = {}) {
        const url = `${this.baseUrl}${path}`;
        const cached = this.cache.get(url);
        if (cached) {
            this.emit("cache-hit", url);
            return cached;
        }
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} on ${url}`);
        }
        const data = await response.json();
        this.cache.set(url, data);
        this.emit("fetch", { url, status: response.status });
        return data;
    }
}

module.exports = { HttpService, Cache };
