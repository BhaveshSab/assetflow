-- One ACTIVE allocation per asset, enforced by the database.
--
-- The application already refuses a second allocation inside a transaction that
-- locks the asset row (see allocations.service.ts). This index is the second
-- line of defence: it makes the rule impossible to break from a script, a
-- migration, a background job or a manual UPDATE in a SQL console.
--
-- The guard below fails the migration with a readable message instead of a
-- cryptic "could not create unique index" if the existing data already violates
-- the rule (that would be a real bug worth stopping for, not something to
-- silently work around).
DO $$
DECLARE
  offenders integer;
BEGIN
  SELECT count(*) INTO offenders
  FROM (
    SELECT "assetId"
    FROM "Allocation"
    WHERE "status" = 'ACTIVE'
    GROUP BY "assetId"
    HAVING count(*) > 1
  ) AS duplicated;

  IF offenders > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce one ACTIVE allocation per asset: % asset(s) already have more than one. Resolve them first.',
      offenders;
  END IF;
END
$$;

CREATE UNIQUE INDEX "Allocation_one_active_per_asset"
  ON "Allocation" ("assetId")
  WHERE "status" = 'ACTIVE';
