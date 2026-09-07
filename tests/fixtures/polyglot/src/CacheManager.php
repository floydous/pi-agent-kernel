<?php
// PHP fixture: real cache service with interfaces, traits, and a manager class.
namespace App\Services;

interface CacheInterface
{
    public function get(string $key): mixed;
    public function set(string $key, mixed $value, int $ttl = 3600): bool;
    public function delete(string $key): bool;
}

trait LoggerTrait
{
    protected function log(string $msg): void
    {
        error_log("[Cache] " . $msg);
    }
}

class CacheManager implements CacheInterface
{
    use LoggerTrait;

    public const DEFAULT_TTL = 3600;
    public const MAX_ENTRIES = 1000;

    private array $store = [];
    private int $hits = 0;
    private int $misses = 0;

    public function get(string $key): mixed
    {
        if (!array_key_exists($key, $this->store)) {
            $this->misses++;
            return null;
        }
        $this->hits++;
        return $this->store[$key]['value'];
    }

    public function set(string $key, mixed $value, int $ttl = self::DEFAULT_TTL): bool
    {
        if (count($this->store) >= self::MAX_ENTRIES) {
            $this->log("Cache full, evicting oldest entry");
            array_shift($this->store);
        }
        $this->store[$key] = ['value' => $value, 'expires_at' => time() + $ttl];
        return true;
    }

    public function delete(string $key): bool
    {
        if (!array_key_exists($key, $this->store)) {
            return false;
        }
        unset($this->store[$key]);
        return true;
    }

    public static function flushAll(): bool
    {
        return true;
    }

    public function stats(): array
    {
        return [
            'entries' => count($this->store),
            'hits' => $this->hits,
            'misses' => $this->misses,
        ];
    }
}
