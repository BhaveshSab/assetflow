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
import { AllocationsService } from './allocations.service';
import { CreateAllocationDto } from './dto/create-allocation.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { QueryAllocationsDto } from './dto/query-allocations.dto';
import { QueryTransfersDto } from './dto/query-transfers.dto';
import { ReturnAllocationDto } from './dto/return-allocation.dto';
import type { AuthUser } from '../auth/jwt.strategy';

/**
 * Feature 5 — Allocation & Transfer.
 * Who holds what (with conflict rules) + the transfer approval workflow.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AllocationsController {
  constructor(private readonly allocations: AllocationsService) {}

  // --- Allocation --------------------------------------------------------

  /** Allocate an available asset to a user or a department. */
  @Post('allocations')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  allocate(
    @Body() dto: CreateAllocationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.allocations.allocate(dto, user);
  }

  /** Check an asset back in (only on an ACTIVE allocation).
   *  Managers may return any allocation; the holder may return their own. */
  @Post('allocations/:id/return')
  @HttpCode(200)
  returnAllocation(
    @Param('id') id: string,
    @Body() dto: ReturnAllocationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.allocations.returnAllocation(id, dto, user);
  }

  /** List allocations. overdue=true filters ACTIVE + past expectedReturnDate.
   *  Manager roles only — employees use GET /allocations/my to see their own.
   *  DEPARTMENT_HEAD is scoped to their own department by the service. */
  @Get('allocations')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  list(
    @Query() query: QueryAllocationsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.allocations.list(query, user);
  }

  /** My allocations — where I'm the holder or the allocator. */
  @Get('allocations/my')
  listMy(@CurrentUser() user: AuthUser) {
    return this.allocations.listMyAllocations(user.id);
  }

  /** Overdue allocations for the dashboard + reminders. */
  @Get('allocations/overdue')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  listOverdue(@CurrentUser() user: AuthUser) {
    return this.allocations.listOverdue(user);
  }

  // --- Transfer workflow -------------------------------------------------

  /** Request a transfer of a currently-allocated asset. */
  @Post('transfers')
  requestTransfer(
    @Body() dto: CreateTransferDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.allocations.requestTransfer(dto, user);
  }

  /** Approve a transfer — re-allocates the asset to the new holder. */
  @Post('transfers/:id/approve')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  approveTransfer(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.allocations.approveTransfer(id, user);
  }

  /** Reject a transfer. */
  @Post('transfers/:id/reject')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  rejectTransfer(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.allocations.rejectTransfer(id, user);
  }

  /** List transfer requests — manager roles only. */
  @Get('transfers')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER, Role.DEPARTMENT_HEAD)
  listTransfers(@Query() query: QueryTransfersDto, @CurrentUser() user: AuthUser) {
    return this.allocations.listTransfers(query, user);
  }
}
