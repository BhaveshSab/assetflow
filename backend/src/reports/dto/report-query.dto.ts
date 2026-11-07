import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { ANALYTICS_RANGES, type AnalyticsRange } from '../reports.service';

/**
 * Shared query params for the ranked analytics reports. Everything is optional;
 * `limit` caps how many rows a ranked list returns (hard-capped at 200 per the
 * house rule so a report can never fetch an unbounded page).
 */
export class ReportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Range selector for GET /reports/analytics. */
export class AnalyticsQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_RANGES)
  range?: AnalyticsRange;
}
