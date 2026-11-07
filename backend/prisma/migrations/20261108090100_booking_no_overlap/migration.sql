-- No two non-cancelled bookings of the same asset may overlap.
--
-- The application checks this inside a transaction that locks the asset row
-- (bookings.service.ts). An EXCLUDE constraint moves the rule into the storage
-- engine, where it holds even for concurrent writers on different processes.
--
-- `tsrange` (not `tstzrange`) because Prisma stores DateTime as `timestamp(3)`
-- without a time zone, and casting inside an index expression would be STABLE,
-- which Postgres refuses in an index definition.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A booking that ends before it starts is never meaningful.
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_time_order"
  CHECK ("endTime" > "startTime");

-- Two half-open ranges [start, end) overlap unless one ends before the other
-- begins; touching boundaries are allowed.
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_no_overlap"
  EXCLUDE USING gist (
    "assetId" WITH =,
    tsrange("startTime", "endTime") WITH &&
  )
  WHERE ("status" <> 'CANCELLED');
