import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';

import { MetricsService } from './metrics.service';

/**
 * `GET /api/metrics` — the Prometheus scrape endpoint.
 *
 * It is **disabled by default** (`METRICS_ENABLED`): the endpoint exposes
 * request rates and error rates, which is information nobody outside the
 * private network should see. The self-hosted stack enables it and lets only
 * Nginx (inside the host) reach it.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    if (!this.metricsEnabled()) {
      res.status(404).json({
        statusCode: 404,
        message: 'Not Found',
        error: 'Not Found',
      });
      return;
    }

    res.setHeader('Content-Type', this.metrics.contentType);
    res.status(200).send(await this.metrics.scrape());
  }

  private metricsEnabled(): boolean {
    return process.env.METRICS_ENABLED === 'true';
  }
}
