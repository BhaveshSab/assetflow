import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * A tiny, defensive wrapper around Redis.
 *
 * Rules that this class enforces:
 *  - **Never throws.** Every method returns `null` when Redis is unreachable,
 *    so a Redis outage can never take the API down.
 *  - **Never blocks the request path.** The client is created lazily and
 *    every call has a short timeout.
 *  - **Reports its own health.** `degraded` is exposed through
 *    `GET /api/health` and a Prometheus gauge, so an outage is *visible*
 *    instead of silent.
 *
 * When `REDIS_URL` is not set the service stays completely inert — the API
 * then uses the in-process (single instance) stores, exactly as before.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;
  private connecting = false;
  private lastError: string | null = null;
  private readonly logger = new Logger(RedisService.name);

  /** The configured Redis URL, or `undefined` when Redis is not used. */
  readonly url: string | undefined;

  constructor(config: ConfigService) {
    this.url = config.get<string>('REDIS_URL')?.trim() || undefined;
  }

  /** True when a `REDIS_URL` is configured (the feature is *wanted*). */
  get enabled(): boolean {
    return Boolean(this.url);
  }

  /** True when Redis was wanted but is currently not answering. */
  get degraded(): boolean {
    return this.enabled && this.lastError !== null;
  }

  /** The last connection error, for the health endpoint. */
  get error(): string | null {
    return this.lastError;
  }

  /** The live client, or `null` when Redis is not configured. */
  getClient(): Redis | null {
    if (!this.url) return null;
    if (this.client) return this.client;
    if (this.connecting) return null;

    this.connecting = true;
    try {
      const client = new Redis(this.url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        // Exponential backoff, capped at 5s — a flapping Redis must not
        // generate a reconnect storm.
        retryStrategy: (times) => Math.min(times * 500, 5000),
      });

      client.on('error', (err: Error) => {
        // Only the transition is logged, otherwise a down Redis floods the
        // log with one line per reconnection attempt.
        if (this.lastError === null) {
          this.logger.warn(`Redis is unavailable: ${err.message}`);
        }
        this.lastError = err.message;
      });

      client.on('ready', () => {
        if (this.lastError !== null) {
          this.logger.log('Redis is available again');
        }
        this.lastError = null;
      });

      this.client = client;
      return client;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not create the Redis client: ${this.lastError}`);
      return null;
    } finally {
      this.connecting = false;
    }
  }

  /** Run a Lua script. Returns `null` when Redis is unavailable. */
  async eval<T>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T | null> {
    const client = this.getClient();
    if (!client) return null;
    try {
      const result = (await client.eval(
        script,
        keys.length,
        ...keys,
        ...args.map(String),
      )) as T;
      return result;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** `DEL` a key. Returns true when the key was removed. */
  async del(key: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;
    try {
      return (await client.del(key)) > 0;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
    this.client = null;
  }
}
