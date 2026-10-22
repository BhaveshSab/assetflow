import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 429 — Nest has no dedicated class for it, so build one explicitly. */
export class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

type AttemptRecord = {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
};

/** Hard cap so a flood of unique keys can never grow the map without bound. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Per-account brute-force protection for the sign-in endpoint.
 *
 * Keeps a sliding window of failed attempts per `email + ip` key and blocks
 * further attempts once the limit is reached. A successful sign-in clears the
 * counter.
 *
 * The store is in-process (per instance). On a serverless deployment each
 * instance keeps its own counters, which is a known trade-off — it still
 * blocks a single brute-force run, it just does not synchronise across
 * instances. The global per-IP throttle (see `AppModule`) covers that case.
 */
@Injectable()
export class LoginThrottleService {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(private readonly config: ConfigService) {}

  /** Throws 429 when the key is currently blocked. */
  assertNotBlocked(key: string): void {
    const record = this.attempts.get(key);
    if (!record) return;

    const now = Date.now();
    if (record.blockedUntil > now) {
      const seconds = Math.ceil((record.blockedUntil - now) / 1000);
      throw new TooManyRequestsException(
        `Too many failed sign-in attempts. Please try again in ${seconds} second(s).`,
      );
    }
    // The block expired — start a fresh window on the next failure.
    if (record.blockedUntil !== 0 && now >= record.blockedUntil) {
      this.attempts.delete(key);
    }
  }

  /** Register a failed attempt; blocks the key once the limit is exceeded. */
  recordFailure(key: string): void {
    const now = Date.now();
    const ttl = this.limitWindowMs();
    const limit = this.maxFailures();

    const record = this.attempts.get(key);
    if (!record || now - record.firstFailureAt > ttl) {
      this.pruneIfNeeded();
      this.attempts.set(key, {
        failures: 1,
        firstFailureAt: now,
        blockedUntil: limit <= 1 ? now + ttl : 0,
      });
      return;
    }

    record.failures += 1;
    if (record.failures >= limit) {
      record.blockedUntil = now + ttl;
    }
  }

  /** A successful sign-in wipes the counter for that key. */
  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  /** Test helper — drops every tracked key. */
  reset(): void {
    this.attempts.clear();
  }

  private maxFailures(): number {
    // Read from the environment on every call so the limit can be tuned (or
    // lowered in a test) without rebuilding the container.
    return this.readNumber('AUTH_THROTTLE_LIMIT', 10);
  }

  private limitWindowMs(): number {
    return this.readNumber('AUTH_THROTTLE_TTL', 15 * 60_000);
  }

  /**
   * `ConfigModule` copies the validated environment back into `process.env`,
   * so the value is identical to the configured one — but reading it live
   * keeps the throttle tunable at runtime.
   */
  private readNumber(key: string, fallback: number): number {
    const raw = process.env[key] ?? this.config.get<string>(key) ?? undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /** Keeps the map bounded — drops the oldest entries when it grows too big. */
  private pruneIfNeeded(): void {
    if (this.attempts.size < MAX_TRACKED_KEYS) return;
    const now = Date.now();
    for (const [key, record] of this.attempts) {
      if (record.blockedUntil <= now) this.attempts.delete(key);
    }
    // Still too big (all entries are blocked): drop the oldest ones.
    while (this.attempts.size >= MAX_TRACKED_KEYS) {
      const oldest = this.attempts.keys().next();
      if (oldest.done) break;
      this.attempts.delete(oldest.value);
    }
  }
}
