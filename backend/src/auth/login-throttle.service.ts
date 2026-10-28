import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { LoginAttemptStore } from './login-throttle.store';
import { InMemoryLoginAttemptStore } from './login-throttle.store';

/** 429 — Nest has no dedicated class for it, so build one explicitly. */
export class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Injection token for the store that keeps the failed-sign-in counters. */
export const LOGIN_ATTEMPT_STORE = 'LOGIN_ATTEMPT_STORE';

/**
 * Per-account brute-force protection for the sign-in endpoint.
 *
 * Keeps a sliding window of failed attempts per `email + ip` key and blocks
 * further attempts once the limit is reached. A successful sign-in clears the
 * counter.
 *
 * The counters live in a {@link LoginAttemptStore}: the in-process map by
 * default, Redis when `REDIS_URL` is configured. The Redis store is what
 * makes the protection meaningful behind several instances or after a
 * restart — see `login-throttle.store.ts`.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    private readonly config: ConfigService,
    @Inject(LOGIN_ATTEMPT_STORE)
    private readonly store: LoginAttemptStore = new InMemoryLoginAttemptStore(),
  ) {}

  /** Which store is in use (`memory` or `redis`). */
  get kind(): 'memory' | 'redis' {
    return this.store.kind;
  }

  /** Throws 429 when the key is currently blocked. */
  async assertNotBlocked(key: string): Promise<void> {
    const blockedForMs = await this.store.isBlocked(key);
    if (blockedForMs <= 0) return;

    const seconds = Math.ceil(blockedForMs / 1000);
    throw new TooManyRequestsException(
      `Too many failed sign-in attempts. Please try again in ${seconds} second(s).`,
    );
  }

  /** Register a failed attempt; blocks the key once the limit is exceeded. */
  async recordFailure(key: string): Promise<void> {
    await this.store.recordFailure(
      key,
      this.maxFailures(),
      this.limitWindowMs(),
    );
  }

  /** A successful sign-in wipes the counter for that key. */
  async recordSuccess(key: string): Promise<void> {
    await this.store.recordSuccess(key);
  }

  /** Test helper — drops every tracked key. */
  async reset(): Promise<void> {
    await this.store.reset();
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
}
