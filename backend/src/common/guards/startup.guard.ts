import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SKIP_STARTUP_CHECK_KEY } from '../decorators/skip-startup-check.decorator';
import { startupStatus } from '../../config/startup-status';

/**
 * Blocks every request with a readable `503` when the environment could not
 * be validated.
 *
 * Without this the API would either crash on import (an opaque
 * `FUNCTION_INVOCATION_FAILED`) or — worse — start with a broken
 * configuration and fail later in a confusing way. With it, the response
 * names the exact variable that has to be fixed.
 */
@Injectable()
export class StartupGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const error = startupStatus.getError();
    if (!error) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_STARTUP_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );
    // The health endpoint must stay reachable — it is what reports the error.
    if (skip) return true;

    throw new ServiceUnavailableException(
      `AssetFlow API is not configured correctly: ${error}`,
    );
  }
}
