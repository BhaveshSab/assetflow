import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetStatus,
  BookingStatus,
  NotificationType,
  Prisma,
  Role,
} from '@prisma/client';

/** Statuses that make an asset un-bookable even when flagged isBookable. */
const OUT_OF_SERVICE: AssetStatus[] = [
  AssetStatus.RETIRED,
  AssetStatus.DISPOSED,
  AssetStatus.LOST,
  AssetStatus.UNDER_MAINTENANCE,
];

import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/jwt.strategy';
import { NotificationsService } from '../notifications/notifications.service';
import { bookingScope } from '../common/auth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { QueryBookingsDto } from './dto/query-bookings.dto';
import { RescheduleBookingDto } from './dto/reschedule-booking.dto';

/** Public shape of a booked user (never leaks passwordHash). */
const bookedBySelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  departmentId: true,
} satisfies Prisma.UserSelect;

const bookingInclude = {
  asset: true,
  bookedBy: { select: bookedBySelect },
} satisfies Prisma.BookingInclude;

type BookingWithRelations = Prisma.BookingGetPayload<{
  include: typeof bookingInclude;
}>;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Reserve a bookable asset for a time slot. The overlap check + create run
   * inside one transaction so two concurrent requests can't both slip through.
   */
  async create(user: AuthUser, dto: CreateBookingDto) {
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);

    // endTime must be strictly after startTime.
    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }
    // A booking that has already started/finished is never what the user
    // meant — reject it instead of silently storing a stale reservation.
    if (startTime <= new Date()) {
      throw new BadRequestException('startTime must be in the future');
    }

    const booking = await this.prisma.$transaction(async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: dto.assetId } });
      if (!asset) {
        throw new BadRequestException('Asset not found');
      }
      if (!asset.isBookable) {
        throw new ConflictException('This asset is not bookable');
      }
      if (OUT_OF_SERVICE.includes(asset.status)) {
        throw new ConflictException(
          `Asset is out of service and cannot be booked (status: ${asset.status})`,
        );
      }

      // Lock the asset row so two concurrent overlapping bookings can't both
      // pass assertNoOverlap (closes the check-then-write race).
      await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${dto.assetId} FOR UPDATE`;

      await this.assertNoOverlap(tx, dto.assetId, startTime, endTime);

      return tx.booking.create({
        data: {
          assetId: dto.assetId,
          bookedById: user.id,
          startTime,
          endTime,
          purpose: dto.purpose,
          status: BookingStatus.UPCOMING,
        },
        include: bookingInclude,
      });
    });

    await this.activity.log({
      actorId: user.id,
      action: 'booking.created',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: {
        assetId: booking.assetId,
        startTime: booking.startTime.toISOString(),
        endTime: booking.endTime.toISOString(),
      },
    });

    await this.notifications.notify({
      userId: user.id,
      type: NotificationType.BOOKING_CONFIRMED,
      message: `Your booking for "${booking.asset.name}" is confirmed.`,
      relatedEntityType: 'Booking',
      relatedEntityId: booking.id,
    });

    return this.withEffectiveStatus(booking);
  }

  /** Calendar / list view with filters. Returns { items, total }. */
  async findAll(user: AuthUser, query: QueryBookingsDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const where: Prisma.BookingWhereInput = {
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.mine ? { bookedById: user.id } : {}),
    };

    // Date-range (calendar) filter: keep bookings overlapping [from, to).
    if (query.from) {
      where.endTime = { gt: new Date(query.from) };
    }
    if (query.to) {
      where.startTime = { lt: new Date(query.to) };
    }

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: bookingInclude,
        orderBy: { startTime: 'asc' },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      items: items.map((b) => this.withEffectiveStatus(b)),
      total,
    };
  }

  /** A single booking — only visible to its booker or a manager. */
  async findOne(user: AuthUser, id: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id, ...bookingScope(user) },
      include: bookingInclude,
    });
    if (!booking) {
      // Do not leak the existence of someone else's booking.
      throw new NotFoundException('Booking not found');
    }
    return this.withEffectiveStatus(booking);
  }

  /** Cancel a future/ongoing booking. Booker, ADMIN or ASSET_MANAGER only. */
  async cancel(user: AuthUser, id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: bookingInclude,
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    this.assertBookerOrManager(user, booking.bookedById);

    const effective = this.effectiveStatus(booking, new Date());
    if (effective === BookingStatus.CANCELLED) {
      throw new ConflictException('Booking is already cancelled');
    }
    if (effective === BookingStatus.COMPLETED) {
      throw new ConflictException('Completed bookings cannot be cancelled');
    }

    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.CANCELLED },
      include: bookingInclude,
    });

    await this.activity.log({
      actorId: user.id,
      action: 'booking.cancelled',
      entityType: 'Booking',
      entityId: updated.id,
      metadata: { assetId: updated.assetId },
    });

    await this.notifications.notify({
      userId: updated.bookedById,
      type: NotificationType.BOOKING_CANCELLED,
      message: `Your booking for "${updated.asset.name}" was cancelled.`,
      relatedEntityType: 'Booking',
      relatedEntityId: updated.id,
    });

    return this.withEffectiveStatus(updated);
  }

  /**
   * Move a booking to a new slot. Re-runs the same overlap validation
   * (excluding this booking) inside a transaction. Booker/manager only.
   */
  async reschedule(user: AuthUser, id: string, dto: RescheduleBookingDto) {
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);

    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }
    if (startTime <= new Date()) {
      throw new BadRequestException('startTime must be in the future');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id } });
      if (!booking) {
        throw new NotFoundException('Booking not found');
      }
      this.assertBookerOrManager(user, booking.bookedById);
      if (booking.status === BookingStatus.CANCELLED) {
        throw new ConflictException('Cancelled bookings cannot be rescheduled');
      }
      if (new Date() >= booking.endTime) {
        throw new ConflictException('Completed bookings cannot be rescheduled');
      }

      await tx.$queryRaw`SELECT id FROM "Asset" WHERE id = ${booking.assetId} FOR UPDATE`;

      await this.assertNoOverlap(tx, booking.assetId, startTime, endTime, id);

      return tx.booking.update({
        where: { id },
        data: { startTime, endTime },
        include: bookingInclude,
      });
    });

    await this.activity.log({
      actorId: user.id,
      action: 'booking.rescheduled',
      entityType: 'Booking',
      entityId: updated.id,
      metadata: {
        assetId: updated.assetId,
        startTime: updated.startTime.toISOString(),
        endTime: updated.endTime.toISOString(),
      },
    });

    await this.notifications.notify({
      userId: updated.bookedById,
      type: NotificationType.BOOKING_CONFIRMED,
      message: `Your booking for "${updated.asset.name}" was rescheduled.`,
      relatedEntityType: 'Booking',
      relatedEntityId: updated.id,
    });

    return this.withEffectiveStatus(updated);
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Reject (409) if any non-cancelled booking for the asset overlaps
   * [startTime, endTime). Two intervals overlap unless they are disjoint:
   *   existing.endTime <= new.startTime  OR  existing.startTime >= new.endTime.
   * The negation (an overlap) is: existing.startTime < new.endTime AND
   * existing.endTime > new.startTime. Touching boundaries do NOT overlap.
   */
  private async assertNoOverlap(
    tx: Prisma.TransactionClient,
    assetId: string,
    startTime: Date,
    endTime: Date,
    excludeBookingId?: string,
  ): Promise<void> {
    const conflict = await tx.booking.findFirst({
      where: {
        assetId,
        status: { not: BookingStatus.CANCELLED },
        startTime: { lt: endTime },
        // A booking that already ended can never clash with a future slot.
        endTime: { gt: new Date(Math.max(startTime.getTime(), Date.now())) },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      },
    });
    if (conflict) {
      throw new ConflictException(
        'This time slot overlaps an existing booking for this asset',
      );
    }
  }

  /** Only the booker, an ADMIN, or an ASSET_MANAGER may mutate a booking. */
  private assertBookerOrManager(user: AuthUser, bookedById: string): void {
    const isManager =
      user.role === Role.ADMIN || user.role === Role.ASSET_MANAGER;
    if (user.id !== bookedById && !isManager) {
      throw new ForbiddenException(
        'Only the booker or a manager can perform this action',
      );
    }
  }

  /**
   * Derive the display status. Persisted status is only ever UPCOMING or
   * CANCELLED; ONGOING/COMPLETED are computed from the clock for display.
   */
  private effectiveStatus(
    booking: { status: BookingStatus; startTime: Date; endTime: Date },
    now: Date,
  ): BookingStatus {
    if (booking.status === BookingStatus.CANCELLED) {
      return BookingStatus.CANCELLED;
    }
    if (now < booking.startTime) return BookingStatus.UPCOMING;
    if (now < booking.endTime) return BookingStatus.ONGOING;
    return BookingStatus.COMPLETED;
  }

  private withEffectiveStatus(booking: BookingWithRelations) {
    return {
      ...booking,
      effectiveStatus: this.effectiveStatus(booking, new Date()),
    };
  }
}
