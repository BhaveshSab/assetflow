import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { RecordStatus } from '@prisma/client';

/** Body for POST /org/categories (ADMIN only). */
export class CreateCategoryDto {
  @IsString()
  @MinLength(2)
  name: string;

  /**
   * JSON array of field definitions, e.g.
   * [{ "key": "warrantyMonths", "type": "number" }].
   * Stored verbatim on AssetCategory.customFields.
   */
  @IsOptional()
  @IsArray()
  customFields?: unknown[];

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;
}
