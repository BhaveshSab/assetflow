import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { MaintenancePriority, MaintenanceStatus } from '@prisma/client';

/** Query filters for GET /maintenance. */
export class ListMaintenanceDto {
  @IsOptional()
  @IsString()
  assetId?: string;

  /**
   * Single status (e.g. PENDING) or comma-separated list
   * (e.g. PENDING,TECHNICIAN_ASSIGNED,IN_PROGRESS) → both accepted.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  })
  @IsArray()
  @IsEnum(MaintenanceStatus, { each: true })
  status?: MaintenanceStatus | MaintenanceStatus[];

  @IsOptional()
  @IsEnum(MaintenancePriority)
  priority?: MaintenancePriority;

  /** "true" → only requests raised by the current user. */
  @IsOptional()
  @IsBooleanString()
  mine?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(0)
  skip?: number;

  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
