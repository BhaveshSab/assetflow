import { Global, Module } from '@nestjs/common';

import { RedisThrottlerStorage } from '../rate-limit/redis-throttler.storage';
import { RedisService } from './redis.service';

/**
 * Makes the (optional) shared Redis store available everywhere.
 *
 * The module is `@Global` so `RedisService` can be injected into any module
 * without importing it explicitly. When `REDIS_URL` is not set the service
 * stays inert and the API keeps using its in-process stores.
 */
@Global()
@Module({
  providers: [RedisService, RedisThrottlerStorage],
  exports: [RedisService, RedisThrottlerStorage],
})
export class RedisModule {}
