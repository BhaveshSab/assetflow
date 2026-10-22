import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';

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

  // Allow the React dev server (and any configured origins) to call the API.
  const origins = (
    process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

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
