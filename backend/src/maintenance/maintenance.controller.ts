import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AssignMaintenanceDto } from './dto/assign-maintenance.dto';
import { CreateMaintenanceDto } from './dto/create-maintenance.dto';
import { ListMaintenanceDto } from './dto/list-maintenance.dto';
import { ResolveMaintenanceDto } from './dto/resolve-maintenance.dto';
import { MaintenanceService } from './maintenance.service';
import type { AuthUser } from '../auth/jwt.strategy';

@Controller('maintenance')
@UseGuards(JwtAuthGuard)
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  /** Raise a repair request against an asset. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMaintenanceDto) {
    return this.maintenance.create(user, dto);
  }

  /** PENDING → APPROVED (also flips the asset to UNDER_MAINTENANCE). */
  @Post(':id/approve')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.maintenance.approve(user, id);
  }

  /** PENDING → REJECTED. */
  @Post(':id/reject')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.maintenance.reject(user, id);
  }

  /** APPROVED → TECHNICIAN_ASSIGNED. */
  @Post(':id/assign')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssignMaintenanceDto,
  ) {
    return this.maintenance.assign(user, id, dto);
  }

  /** TECHNICIAN_ASSIGNED → IN_PROGRESS. */
  @Post(':id/start')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.maintenance.start(user, id);
  }

  /** (IN_PROGRESS | TECHNICIAN_ASSIGNED | APPROVED) → RESOLVED (asset back to AVAILABLE). */
  @Post(':id/resolve')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ResolveMaintenanceDto,
  ) {
    return this.maintenance.resolve(user, id, dto);
  }

  /** Filterable list: assetId, status, priority, mine. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListMaintenanceDto) {
    return this.maintenance.list(user, query);
  }

  /** Convenience alias for the employee dashboard: my maintenance requests. */
  @Get('my')
  myRequests(@CurrentUser() user: AuthUser) {
    return this.maintenance.list(user, {
      mine: 'true',
    });
  }

  /** Single maintenance request — only visible within the caller's scope. */
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.maintenance.findOne(user, id);
  }
}
