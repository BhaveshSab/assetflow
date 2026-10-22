import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import type { AuthUser } from '../auth/jwt.strategy';
import { NotificationsService } from './notifications.service';
import { PingAllocationDto } from './dto/ping-allocation.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';

/** Feature 10 — a user's own notification feed. Any logged-in user. */
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListNotificationsDto) {
    return this.notifications.listForUser(user.id, query.unread === true);
  }

  @Patch(':id/read')
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  /**
   * Send an overdue-return reminder to the holder of an allocation.
   * Reserved for the roles that triage overdue allocations — an ordinary
   * employee must not be able to spam other users with reminders.
   */
  @Post('ping')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  ping(@CurrentUser() user: AuthUser, @Body() dto: PingAllocationDto) {
    return this.notifications.pingAllocation(user, dto.allocationId);
  }
}
