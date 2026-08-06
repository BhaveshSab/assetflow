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

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { QueryBookingsDto } from './dto/query-bookings.dto';
import { RescheduleBookingDto } from './dto/reschedule-booking.dto';

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /** Reserve a bookable asset for a time slot (any authenticated user). */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create(user, dto);
  }

  /** Calendar / list view with filters: assetId, status, from, to, mine. */
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryBookingsDto) {
    return this.bookings.findAll(user, query);
  }

  /** Convenience alias for the employee dashboard: the current user's bookings. */
  @Get('my')
  myBookings(@CurrentUser() user: AuthUser) {
    return this.bookings.findAll(user, {
      mine: true,
    } as QueryBookingsDto);
  }

  /** Fetch a single booking by id. */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.bookings.findOne(id);
  }

  /** Cancel a booking (booker, ADMIN or ASSET_MANAGER). */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.cancel(user, id);
  }

  /** Move a booking to a new slot (booker, ADMIN or ASSET_MANAGER). */
  @Patch(':id/reschedule')
  reschedule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RescheduleBookingDto,
  ) {
    return this.bookings.reschedule(user, id, dto);
  }
}
