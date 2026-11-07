import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthAttemptStore } from './auth-throttle.store';
import { InMemoryAuthAttemptStore } from './auth-throttle.store';

/** 429 — Nest has no dedicated class for it, so build one explicitly. */
export class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Injection token for the store that keeps the failed-sign-in counters. */
export const AUTH_ATTEMPT_STORE = 'AUTH_ATTEMPT_STORE';

/**
 * The attempt counter behind every unauthenticated auth endpoint.
 *
 * It started as brute-force protection for sign-in and now backs three keys,
 * each namespaced so the flows cannot spend each other's budget:
 *
 *   `login:<email>|<ip>`     failed sign-ins — a success clears the counter
 *   `signup:<ip>`            account creation — 10 per window per address
 *   `reset:<email>|<ip>`     password-reset mails — 10 per window per pair
 *
 * The limits come from `AUTH_THROTTLE_LIMIT` / `AUTH_THROTTLE_TTL` (10 per
 * 15 minutes by default) and are read on every call, so a deployment can tune
 * them without a rebuild and a test can lower them to observe a real 429.
 *
 * The counters live in an {@link AuthAttemptStore}: the in-process map by
 * default, Redis when `REDIS_URL` is configured. The Redis store is what
 * makes the protection meaningful behind several instances or after a
 * restart — see `auth-throttle.store.ts`.
 */
@Injectable()
export class AuthThrottleService {
  constructor(
    private readonly config: ConfigService,
    @Inject(AUTH_ATTEMPT_STORE)
    private readonly store: AuthAttemptStore = new InMemoryAuthAttemptStore(),
  ) {}

  /** Which store is in use (`memory` or `redis`). */
  get kind(): 'memory' | 'redis' {
    return this.store.kind;
  }

  /**
   * Throws 429 when the key is currently blocked.
   *
   * `message` names the action that was attempted ("sign-up", "reset
   * request", …); the remaining wait is appended so the caller knows whether
   * to retry in a moment or in a quarter of an hour.
   */
  async assertNotBlocked(
    key: string,
    message = 'Too many attempts',
  ): Promise<void> {
    const blockedForMs = await this.store.isBlocked(key);
    if (blockedForMs <= 0) return;

    const seconds = Math.ceil(blockedForMs / 1000);
    throw new TooManyRequestsException(
      `${message}. Please try again in ${seconds} second(s).`,
    );
  }

  /**
   * Count one attempt against the key.
   *
   * Used for actions that are not "failures" but must still be rationed —
   * creating an account, or asking for a reset mail. Deliberately *not*
   * cleared on success: a caller who succeeds ten times has still made ten
   * requests.
   */
  async recordAttempt(key: string): Promise<void> {
    await this.store.recordFailure(
      key,
      this.maxFailures(),
      this.limitWindowMs(),
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
