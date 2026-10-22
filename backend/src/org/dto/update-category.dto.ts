import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { RecordStatus } from '@prisma/client';

/** Body for PATCH /org/categories/:id (ADMIN only). All fields optional. */
export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsArray()
  customFields?: unknown[];

  @IsOptional()
  @IsEnum(RecordStatus)
  status?: RecordStatus;
}
