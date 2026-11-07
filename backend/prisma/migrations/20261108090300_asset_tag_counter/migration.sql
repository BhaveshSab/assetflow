-- Asset tags (AF-0001, AF-0002, …) are handed out from a single counter row.
--
-- Why not MAX(tag) + 1: it is a read-modify-write. Two concurrent registrations
-- read the same maximum and fight over the same tag; the unique index catches
-- the loser, but the retry loop then competes with every other writer, and under
-- a burst the budget runs out and the registration fails with a 500.
--
-- Why not a sequence: a sequence is atomic, but it knows nothing about rows that
-- appear out of band (a data import, a restore, a manual INSERT). It would hand
-- out AF-0003 while AF-10000 already exists — unique, but confusing for a
-- user-facing identifier, and it breaks "tags follow the catalogue".
--
-- A counter row locked FOR UPDATE gives both: the row lock serialises writers
-- (no collisions, no retries), and the allocation takes GREATEST(counter, MAX)
-- under that lock, so imported rows are respected. A rolled-back transaction
-- rolls the counter back with it, so no numbers are burned.
CREATE TABLE "AssetTagCounter" (
  "id"    INTEGER NOT NULL,
  "value" BIGINT  NOT NULL DEFAULT 0,
  CONSTRAINT "AssetTagCounter_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AssetTagCounter" ("id", "value")
SELECT 1, COALESCE(
  MAX(CAST(RIGHT("assetTag", LENGTH("assetTag") - 3) AS BIGINT)),
  0
)
FROM "Asset"
WHERE "assetTag" LIKE 'AF-%'
  AND RIGHT("assetTag", LENGTH("assetTag") - 3) ~ '^[0-9]+$';
