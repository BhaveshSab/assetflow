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

/**
 * True when the connection string points at Neon (…neon.tech). Neon is reached
 * through the WebSocket driver adapter because raw Postgres TCP (5432) is
 * blocked on many networks; every other Postgres uses the node-postgres
 * driver adapter.
 */
export function isNeonUrl(connectionString: string): boolean {
  return /\.neon\.tech/i.test(connectionString);
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
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy backend/.env.example to backend/.env and point it at your Postgres database.',
    );
  }
  return new PrismaClient({
    adapter: isNeonUrl(connectionString)
      ? new PrismaNeon({ connectionString })
      : new PrismaPg({ connectionString }),
  });
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
    super({
      adapter: (() => {
        const connectionString = process.env.DATABASE_URL ?? '';
        if (!connectionString) {
          throw new Error(
            'DATABASE_URL is not set. Copy backend/.env.example to backend/.env and point it at your Postgres database.',
          );
        }
        return isNeonUrl(connectionString)
          ? new PrismaNeon({ connectionString })
          : new PrismaPg({ connectionString });
      })(),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  /** Release the connection pool when the Nest container shuts down. */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
