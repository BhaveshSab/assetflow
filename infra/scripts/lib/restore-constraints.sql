-- Read-only checks of the intended public tables and actual enforcement.
-- Canonicalize formatting, not semantic tokens, for PostgreSQL 16 definitions.
SELECT
EXISTS (
 SELECT 1 FROM pg_index i
 JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.oid = to_regclass('public."Allocation_one_active_per_asset"')
   AND i.indrelid = 'public."Allocation"'::regclass
   AND i.indisunique AND i.indisvalid AND i.indisready
   AND i.indnkeyatts = 1 AND i.indnatts = 1
   AND pg_get_indexdef(i.indexrelid, 1, true) = '"assetId"'
   AND regexp_replace(pg_get_expr(i.indpred, i.indrelid), '[[:space:]()]', '', 'g')
       = 'status=''ACTIVE''::"AllocationStatus"'
)
AND EXISTS (
 SELECT 1 FROM pg_constraint c
 WHERE c.conrelid = 'public."Booking"'::regclass
   AND c.conname = 'Booking_no_overlap' AND c.contype = 'x' AND c.convalidated
   AND regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]()]', '', 'g')
       = 'EXCLUDEUSINGgist"assetId"WITH=,tsrange"startTime","endTime"WITH&&WHEREstatus<>''CANCELLED''::"BookingStatus"'
)
AND EXISTS (
 SELECT 1 FROM pg_constraint c
 WHERE c.conrelid = 'public."Booking"'::regclass
   AND c.conname = 'Booking_time_order' AND c.contype = 'c' AND c.convalidated
   AND regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]()]', '', 'g')
       = 'CHECK"endTime">"startTime"'
)
AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist');
