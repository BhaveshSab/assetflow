import { SetMetadata } from '@nestjs/common';

export const SKIP_STARTUP_CHECK_KEY = 'assetflow:skip-startup-check';

/**
 * Marks a route that must stay reachable even when the environment is
 * invalid — currently only `GET /api/health`, which is the endpoint that
 * *reports* the problem.
 */
export const SkipStartupCheck = () => SetMetadata(SKIP_STARTUP_CHECK_KEY, true);
