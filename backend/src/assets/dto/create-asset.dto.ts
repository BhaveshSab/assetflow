import { AssetCondition } from '@prisma/client';
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

/** Body for POST /assets. Registers a new asset; assetTag is auto-generated. */
export class CreateAssetDto {
  @IsString()
  name: string;

  @IsString()
  categoryId: string;

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

  // list of { name, url } — stored as Json (validated: see IsDocumentList).
  @IsOptional()
  @IsDocumentList()
  documents?: unknown[];

  @IsOptional()
  @IsBoolean()
  isBookable?: boolean;

  // per-asset values for the category's custom field definitions — stored as
  // Json (validated: see IsCustomFieldMap).
  @IsOptional()
  @IsCustomFieldMap()
  customFieldValues?: Record<string, unknown>;
}
