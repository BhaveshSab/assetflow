import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';

import { AppModule } from './app.module';
import { configureApp } from './configure-app';

/**
 * Serverless entrypoint (used by Vercel via `api/index.js`).
 *
 * Vercel invokes the handler once per request, so the Nest app is built once
 * and the underlying Express instance is cached on the warm container.
 * `src/main.ts` remains the entrypoint for long-running local/dev servers.
 */
type ExpressApp = (req: Request, res: Response) => void;

let cached: Promise<ExpressApp> | undefined;

async function createApp(): Promise<ExpressApp> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as ExpressApp;
}

export default async function handler(req: Request, res: Response) {
  cached ??= createApp();
  const app = await cached;
  app(req, res);
}
