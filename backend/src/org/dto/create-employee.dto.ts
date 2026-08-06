import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';

/**
 * Body for POST /org/employees (ADMIN) — provision an account directly from
 * the Employee Directory without requiring the person to self-signup first.
 */
export class CreateEmployeeDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsEmail()
  email: string;

  /** Optional initial password; defaults to "password123" when omitted. */
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  /** Defaults to EMPLOYEE. Only an Admin can set this here anyway. */
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
