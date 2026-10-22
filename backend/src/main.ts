import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Trust the platform's proxy (Vercel) so `req.ip` is the real client IP.
  configureApp(app);

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');

  new Logger('Bootstrap').log(
    `AssetFlow API running on http://localhost:${port}/api`,
  );
}

bootstrap().catch((err) => {
  console.error('Failed to start AssetFlow API:', err);
  process.exit(1);
});
