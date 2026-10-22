import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Neon's serverless driver tunnels Postgres over a WebSocket on port 443.
// Node has a global WebSocket from v22, but we pin `ws` so this also works on
// older runtimes.
neonConfig.webSocketConstructor = ws;

/** Which driver adapter a connection string needs. */
export type DriverKind = 'neon-websocket' | 'pg';

/**
 * A syntactically valid but unreachable connection string.
 *
 * It is used when `DATABASE_URL` is missing or unusable: the Prisma client
 * can then be constructed (so the process starts and `GET /api/health` can
 * report the problem) instead of throwing during module import — which
 * Vercel reports as an opaque `500 FUNCTION_INVOCATION_FAILED`.
 */
export const FALLBACK_CONNECTION_STRING =
  'postgresql://invalid:invalid@127.0.0.1:1/invalid';

/** The hostname of a connection string (best effort). */
export function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    const match = /@([^/?#:]+)/.exec(connectionString);
    return match ? match[1] : '';
  }
}

/** True for any Neon host (`*.neon.tech`). */
export function isNeonUrl(connectionString: string): boolean {
  return /\.neon\.tech$/i.test(hostOf(connectionString));
}

/**
 * True for Neon's *pooled* endpoint (`ep-xxx-pooler.<region>.aws.neon.tech`).
 *
 * The pooled endpoint is PgBouncer: it only speaks the Postgres wire
 * protocol over TCP and does **not** support the Neon WebSocket protocol, so
 * it must be reached with the `pg` driver instead of the Neon driver.
 */
export function isNeonPoolerUrl(connectionString: string): boolean {
  return hostOf(connectionString).includes('-pooler.');
}

/**
 * Pick the driver adapter for a connection string.
 *
 * | DATABASE_URL                              | driver            |
 * |-------------------------------------------|-------------------|
 * | `ep-xxx.<region>.aws.neon.tech` (direct)  | Neon (WebSocket)  |
 * | `ep-xxx-pooler.<region>.aws.neon.tech`     | `pg` over TCP     |
 * | anything else (local / RDS / Supabase)     | `pg` over TCP     |
 */
export function selectDriver(connectionString: string): DriverKind {
  if (isNeonUrl(connectionString) && !isNeonPoolerUrl(connectionString)) {
    return 'neon-websocket';
  }
  return 'pg';
}

/** Build the driver adapter for a connection string. */
export function createAdapter(connectionString: string) {
  if (selectDriver(connectionString) === 'neon-websocket') {
    return new PrismaNeon({ connectionString });
  }
  return new PrismaPg({ connectionString });
}

/**
 * Build a Prisma client for the given connection string.
 *
 * The client is generated with `engineType = "client"` (a Rust-free client),
 * so it always needs a driver adapter — never a native query-engine binary.
 * That keeps the deployment artifact small and platform independent.
 *
 * Exported so standalone scripts (e.g. `prisma/seed.ts`) use exactly the same
 * connection strategy as the API.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (!connectionString || !connectionString.trim()) {
    throw new Error(
      'DATABASE_URL is not set. Copy backend/.env.example to backend/.env and point it at your Postgres database.',
    );
  }
  const url = connectionString.trim();
  return new PrismaClient({ adapter: createAdapter(url) });
}

/**
 * Create the adapter for the app itself.
 *
 * Never throws: a broken `DATABASE_URL` must not prevent the process from
 * starting, otherwise the deployment dies with an unreadable error instead
 * of answering `GET /api/health` with the reason.
 */
export function createAppAdapter(connectionString?: string): unknown {
  const url = (connectionString ?? '').trim() || FALLBACK_CONNECTION_STRING;
  try {
    return createAdapter(url);
  } catch (err) {
    console.error(
      `[assetflow] could not create the database adapter for "${hostOf(url)}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return createAdapter(FALLBACK_CONNECTION_STRING);
  }
}

/**
 * Thin wrapper that turns the generated PrismaClient into an injectable Nest
 * provider. Import PrismaModule anywhere you need DB access, then inject this.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // NOTE: read the env var *here*, not at module-import time. `.env` is
    // loaded by ConfigModule when the AppModule is evaluated, which happens
    // after this module has already been imported — reading it at import time
    // silently produced an empty connection string.
    super({ adapter: createAppAdapter(process.env.DATABASE_URL) as never });
  }

  async onModuleInit() {
    try {
      await this.$connect();
    } catch (err) {
      // A database hiccup must not take the whole API down: the health
      // endpoint stays up and reports the problem.
      console.error(
        `[assetflow] could not connect to the database at startup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Release the connection pool when the Nest container shuts down. */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
