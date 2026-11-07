import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { isOriginAllowed, parseOrigins } from './common/http/cors';

/**
 * App-wide configuration shared by every entrypoint.
 *
 * `src/main.ts` uses it for the long-running local/dev server; `serverless.ts`
 * uses it for the Vercel serverless function. Keeping it here means the two
 * can never drift apart.
 */
export function configureApp(app: INestApplication) {
  // All routes are served under /api (matches what the frontend calls).
  app.setGlobalPrefix('api');

  // Security headers. `contentSecurityPolicy` is turned off because this is a
  // JSON API (the SPA owns its own CSP); the rest protects against clickjacking,
  // MIME sniffing and cross-origin resource leaks.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Behind Vercel (or any reverse proxy) `req.ip` is the proxy's IP unless the
  // app trusts the forwarding headers — which would make per-IP rate limiting
  // useless. Trusting one hop is the documented, safe setting for a proxy that
  // sets X-Forwarded-For itself.
  const instance = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
  };
  if (typeof instance?.set === 'function') {
    instance.set('trust proxy', 1);
  }

  // Allow the deployed SPA (and the dev servers, and anything else listed in
  // CORS_ORIGINS) to call the API.
  //
  // The list is passed as an array, which `cors` matches entry by entry by
  // exact string — the same comparison `parseOrigins` normalises for. (The
  // callback form works too, but it answers a refused origin by calling
  // `next()` with no headers at all, losing the `Vary: Origin` that keeps a
  // cache from serving one origin's answer to another.)
  const origins = parseOrigins();
  const corsLogger = new Logger('CORS');

  // Registered before the CORS middleware, because a refused origin is
  // otherwise silent on the server side: the browser says "blocked by CORS"
  // and the log says nothing at all, which is impossible to debug from outside.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, origins)) {
      corsLogger.warn(
        `Blocked cross-origin request from ${origin}. ` +
          `CORS_ORIGINS in this deployment is: ${origins.join(', ')}. ` +
          `Add that origin to CORS_ORIGINS and redeploy the API.`,
      );
    }
    next();
  });

  app.enableCors({
    credentials: true,
    origin: origins.includes('*') ? true : origins,
  });

  // Validate + strip unknown fields on every incoming DTO automatically.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Reject a body that is not an object at all (e.g. `"hello"`), which
      // class-validator would otherwise silently accept.
      forbidUnknownValues: true,
    }),
  );

  // Close the DB pool and stop background work on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const logger = new Logger('Bootstrap');
  logger.log(
    `API configured · CORS origins: ${origins.join(', ') || '(none)'}`,
  );
}
