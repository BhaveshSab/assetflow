-- Read-only checks of the intended public tables and actual enforcement.
--
-- Canonicalization strips whitespace, parentheses AND double quotes, so the
-- comparison cannot depend on whether PostgreSQL chose to quote an identifier.
-- pg_get_constraintdef() renders a column reference as "status" for this schema
-- (the columns are quoted in the migrations), so a canonical form that kept the
-- quotes could never match the unquoted literal below — the check would fail
-- against a perfectly correct restored database. Quotes are formatting here,
-- not meaning: the identifiers are already fixed by the schema.
--
-- What is still asserted exactly: the constraint kind, the column, the operator,
-- the row filter, the enum type and the predicate, plus index validity,
-- readiness and uniqueness. Names alone are never accepted as enforcement.
SELECT
EXISTS (
 SELECT 1 FROM pg_index i
 JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.oid = to_regclass('public."Allocation_one_active_per_asset"')
   AND i.indrelid = 'public."Allocation"'::regclass
   AND i.indisunique AND i.indisvalid AND i.indisready
   AND i.indnkeyatts = 1 AND i.indnatts = 1
   AND regexp_replace(pg_get_indexdef(i.indexrelid, 1, true), '[[:space:]()"]', '', 'g')
       = 'assetId'
   AND regexp_replace(pg_get_expr(i.indpred, i.indrelid), '[[:space:]()"]', '', 'g')
       = 'status=''ACTIVE''::AllocationStatus'
)
AND EXISTS (
 SELECT 1 FROM pg_constraint c
 WHERE c.conrelid = 'public."Booking"'::regclass
   AND c.conname = 'Booking_no_overlap' AND c.contype = 'x' AND c.convalidated
   AND regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]()"]', '', 'g')
       = 'EXCLUDEUSINGgistassetIdWITH=,tsrangestartTime,endTimeWITH&&WHEREstatus<>''CANCELLED''::BookingStatus'
)
AND EXISTS (
 SELECT 1 FROM pg_constraint c
 WHERE c.conrelid = 'public."Booking"'::regclass
   AND c.conname = 'Booking_time_order' AND c.contype = 'c' AND c.convalidated
   AND regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]()"]', '', 'g')
       = 'CHECKendTime>startTime'
)
AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist');
