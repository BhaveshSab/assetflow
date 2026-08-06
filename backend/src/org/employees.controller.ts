import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { EmployeesService } from './employees.service';
import { ListEmployeesDto } from './dto/list-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { UpdateEmployeeRoleDto } from './dto/update-employee-role.dto';
import type { AuthUser } from '../auth/jwt.strategy';

@Controller('org/employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  /** List employees — ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD. */
  @Get()
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  list(@Query() query: ListEmployeesDto) {
    return this.employees.list(query);
  }

  /** Minimal active-employee directory (id/name/email/dept) for picking a
   *  transfer target — any authenticated user may fetch it. Must be declared
   *  before @Get(':id') so the literal "directory" path isn't caught by it. */
  @Get('directory')
  listDirectory() {
    return this.employees.listDirectory();
  }

  /** Provision an employee account directly (ADMIN only). */
  @Post()
  @Roles(Role.ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEmployeeDto) {
    return this.employees.create(user.id, dto);
  }

  /** Employee detail — ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD. */
  @Get(':id')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  findOne(@Param('id') id: string) {
    return this.employees.findOne(id);
  }

  /** Update an employee's profile (ADMIN only). Never changes role. */
  @Patch(':id')
  @Roles(Role.ADMIN)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employees.update(user.id, id, dto);
  }

  /** Change an employee's role (ADMIN ONLY) — the only role-mutating route. */
  @Patch(':id/role')
  @Roles(Role.ADMIN)
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeRoleDto,
  ) {
    return this.employees.updateRole(user.id, id, dto);
  }
}
