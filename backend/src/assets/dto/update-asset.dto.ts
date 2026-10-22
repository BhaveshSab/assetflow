import { AssetCondition, AssetStatus } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

import {
  IsCustomFieldMap,
  IsDocumentList,
} from '../../common/validation/json-fields';

/**
 * Body for PATCH /assets/:id. Edits descriptive fields. `status` may only be
 * moved to a terminal/administrative state here (RETIRED, DISPOSED, LOST) —
 * the workflow-owned states (ALLOCATED, UNDER_MAINTENANCE, RESERVED) are
 * rejected by the service.
 */
export class UpdateAssetDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsDateString()
  acquisitionDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  acquisitionCost?: number;

  @IsOptional()
  @IsEnum(AssetCondition)
  condition?: AssetCondition;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  photoUrl?: string;

  @IsOptional()
  @IsDocumentList()
  documents?: unknown[];

  @IsOptional()
  @IsBoolean()
  isBookable?: boolean;

  @IsOptional()
  @IsCustomFieldMap()
  customFieldValues?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;
}
