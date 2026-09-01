import { INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * App-wide configuration shared by every entrypoint.
 *
 * `src/main.ts` uses it for the long-running local/dev server; `api/index.ts`
 * uses it for the Vercel serverless function. Keeping it here means the two
 * can never drift apart.
 */
export function configureApp(app: INestApplication) {
  // All routes are served under /api (matches what the frontend calls).
  app.setGlobalPrefix('api');

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
    }),
  );
}
