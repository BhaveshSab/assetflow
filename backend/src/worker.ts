import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { startJobsWorker } from './jobs/jobs-worker';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule] })
class WorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  try {
    const close = await startJobsWorker(app.get(PrismaService));
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => process.exit(1), 25000);
      timeout.unref();
      void close()
        .then(() => app.close())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch {
    await app.close();
    throw new Error(
      'Worker startup failed; check JOBS_ENABLED, JOBS_REDIS_URL, DATABASE_URL and metrics port',
    );
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Worker failed');
  process.exit(1);
});
