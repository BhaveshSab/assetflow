import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';

import { AppModule } from './app.module';
import { normalizeUrl } from './common/http/normalize-url';
import { JsonLogger } from './common/logging/json-logger';
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
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as ExpressApp;
}

/**
 * The request handler.
 *
 * Every failure mode is reported as a JSON body with the real reason. The
 * platform would otherwise show an opaque `500 FUNCTION_INVOCATION_FAILED`
 * with no hint about what went wrong (a short `JWT_SECRET`, a missing
 * `DATABASE_URL`, …).
 */
export default async function handler(req: Request, res: Response) {
  try {
    cached ??= createApp();
    const app = await cached;

    const url = normalizeUrl(req.url);
    if (url !== undefined) req.url = url;
    app(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[assetflow] the API could not be initialised:', err);

    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          statusCode: 503,
          error: 'Service Unavailable',
          message: `AssetFlow API could not start: ${message}`,
        }),
      );
    }
  }
}
