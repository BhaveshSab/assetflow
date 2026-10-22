import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { QueryActivityDto } from './dto/query-activity.dto';
import { ActivityService } from './activity.service';

/** Feature 10 — the full audit log of admin/manager/employee actions. */
@Controller('activity')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  list(@Query() query: QueryActivityDto) {
    return this.activity.list({
      take: query.take,
      skip: query.skip,
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
    });
  }
}
