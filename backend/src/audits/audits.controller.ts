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
import { AuditsService } from './audits.service';
import { AssignAuditorsDto } from './dto/assign-auditors.dto';
import { CreateAuditDto } from './dto/create-audit.dto';
import { MarkAuditItemDto } from './dto/mark-audit-item.dto';
import { QueryAuditItemsDto, QueryAuditsDto } from './dto/query-audits.dto';

/** Feature 8 — Asset Audit. Structured verification cycles (batch workflow). */
@Controller('audits')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditsController {
  constructor(private readonly audits: AuditsService) {}

  /** Create a cycle and auto-generate a PENDING AuditItem per in-scope asset. */
  @Post()
  @Roles(Role.ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAuditDto) {
    return this.audits.createCycle(user, dto);
  }

  /** Assign auditors to a cycle (unique per cycle+auditor; duplicates ignored). */
  @Post(':id/auditors')
  @Roles(Role.ADMIN)
  assignAuditors(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssignAuditorsDto,
  ) {
    return this.audits.assignAuditors(user, id, dto);
  }

  /** List cycles with per-cycle result counts and status. */
  @Get()
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  list(@Query() query: QueryAuditsDto) {
    return this.audits.listCycles({
      status: query.status,
      take: query.take,
      skip: query.skip,
    });
  }

  /** Cycle detail: assignments (auditors) + a summary of item results. */
  @Get(':id')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  detail(@Param('id') id: string) {
    return this.audits.getDetail(id);
  }

  /** List a cycle's items with asset info. Assigned auditor or ADMIN/ASSET_MANAGER. */
  @Get(':id/items')
  items(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() query: QueryAuditItemsDto,
  ) {
    return this.audits.listItems(user, id, {
      take: query.take,
      skip: query.skip,
    });
  }

  /** Mark an item VERIFIED | MISSING | DAMAGED. Assigned auditor or manager only. */
  @Patch(':id/items/:itemId')
  markItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: MarkAuditItemDto,
  ) {
    return this.audits.markItem(user, id, itemId, dto);
  }

  /** Auto discrepancy report: all MISSING / DAMAGED items with asset info. */
  @Get(':id/discrepancies')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  discrepancies(@Param('id') id: string) {
    return this.audits.getDiscrepancies(id);
  }

  /** Close a cycle: lock it, mark MISSING assets LOST and DAMAGED assets DAMAGED. */
  @Post(':id/close')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  close(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.audits.close(user, id);
  }
}
