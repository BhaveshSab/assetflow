import { captureTraceparent } from '../telemetry/tracing';
import { Booking, Prisma } from '@prisma/client';

export const REMINDER_LEAD_MS = 30 * 60 * 1000;

/** Must be called on the same transaction as the booking write. */
export async function scheduleBookingReminder(
  tx: Prisma.TransactionClient,
  booking: Booking,
) {
  return tx.jobOutbox.create({
    data: {
      topic: 'booking.reminder',
      traceparent: captureTraceparent(),
      bookingId: booking.id,
      version: booking.reminderVersion,
      availableAt: new Date(booking.startTime.getTime() - REMINDER_LEAD_MS),
    },
  });
}
