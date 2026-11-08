import { BookingStatus, NotificationType, RecordStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REMINDER_LEAD_MS } from './booking-reminder';

/** The only side effect is an in-app DB notification, committed with DONE.
 * A crash before commit retries; a crash after commit observes DONE. This
 * guarantee does NOT extend to SMTP or other external side effects.
 */
export async function processReminder(
  prisma: PrismaService,
  eventId: string,
  epoch: number,
  now = new Date(),
) {
  const counted = await prisma.jobOutbox.updateMany({
    where: {
      id: eventId,
      retryEpoch: epoch,
      status: { in: ['PENDING', 'QUEUED'] },
      attempts: { lt: 5 },
    },
    data: { attempts: { increment: 1 } },
  });
  if (!counted.count) {
    await prisma.jobOutbox.updateMany({
      where: {
        id: eventId,
        retryEpoch: epoch,
        status: { in: ['PENDING', 'QUEUED'] },
        attempts: { gte: 5 },
      },
      data: { status: 'FAILED', lastError: 'AttemptLimit' },
    });
    return;
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "JobOutbox" WHERE id = ${eventId} FOR UPDATE`;
    const event = await tx.jobOutbox.findUnique({ where: { id: eventId } });
    if (
      !event ||
      event.retryEpoch !== epoch ||
      event.status === 'DONE' ||
      event.status === 'FAILED'
    )
      return;
    if (event.topic !== 'booking.reminder')
      throw new Error('UnsupportedJobTopic');
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${event.bookingId} FOR UPDATE`;
    const booking = await tx.booking.findUnique({
      where: { id: event.bookingId },
      include: {
        asset: { select: { name: true, assetTag: true } },
        bookedBy: { select: { status: true } },
      },
    });
    const current =
      booking &&
      booking.reminderVersion === event.version &&
      booking.status !== BookingStatus.CANCELLED &&
      booking.bookedBy.status === RecordStatus.ACTIVE &&
      booking.startTime > now;
    if (
      current &&
      booking.startTime.getTime() - REMINDER_LEAD_MS > now.getTime()
    ) {
      throw new Error('ReminderNotDue');
    }
    if (current) {
      // Legacy sweeper notifications used no key; avoid repeating version 0
      // when queues are first enabled. Later reschedules get a fresh reminder.
      const legacy =
        event.version === 0 &&
        (await tx.notification.findFirst({
          where: {
            userId: booking.bookedById,
            type: NotificationType.BOOKING_REMINDER,
            relatedEntityId: booking.id,
            dedupeKey: null,
          },
        }));
      if (!legacy)
        await tx.notification.upsert({
          where: {
            dedupeKey: `booking-reminder-${booking.id}-${event.version}`,
          },
          update: {},
          create: {
            dedupeKey: `booking-reminder-${booking.id}-${event.version}`,
            userId: booking.bookedById,
            type: NotificationType.BOOKING_REMINDER,
            message: `Reminder: your booking for ${booking.asset.name} (${booking.asset.assetTag}) starts at ${booking.startTime.toISOString()}.`,
            relatedEntityType: 'Booking',
            relatedEntityId: booking.id,
          },
        });
    }
    await tx.jobOutbox.update({
      where: { id: event.id },
      data: {
        status: 'DONE',
        completedAt: now,
        leaseUntil: null,
        lastError: null,
      },
    });
  });
}
