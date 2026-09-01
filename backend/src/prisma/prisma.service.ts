import { INestApplication, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '@prisma/client';
import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Neon's serverless driver tunnels Postgres over a WebSocket on port 443.
// Node has a global WebSocket from v22, but we pin `ws` so this also works on
// older runtimes.
neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL ?? '';

/**
 * Thin wrapper that turns the generated PrismaClient into an injectable Nest
 * provider. Import PrismaModule anywhere you need DB access, then inject this.
 *
 * Neon-hosted databases are reached through the WebSocket driver adapter
 * (port 443) because direct Postgres TCP (5432) is blocked on many networks.
 * Any other connection string falls through to Prisma's default TCP engine.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super(
      /\.neon\.tech/.test(connectionString)
        ? { adapter: new PrismaNeon({ connectionString }) }
        : {},
    );
  }

  async onModuleInit() {
    await this.$connect();
  }

  /** Lets the app close DB connections cleanly on shutdown. */
  async enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}
