import { Prisma } from '@prisma/client';
const ASSET_TAG_PREFIX = 'AF-';
const ASSET_TAG_PAD = 4;
export async function reserveAssetTags(
  tx: Prisma.TransactionClient,
  count: number,
): Promise<string[]> {
  // Take the counter row first: this serialises concurrent registrations, so
  // no two callers can read the same "current" value. Released on COMMIT.
  const counter = await tx.$queryRaw<
    Array<{ value: bigint | number | string }>
  >`
      SELECT "value" FROM "AssetTagCounter" WHERE "id" = 1 FOR UPDATE
    `;

  // The table still wins if it is ahead of the counter (a data import, a
  // restore, a manual INSERT). Read it under the same lock, so the maximum
  // cannot move between this read and the insert.
  //
  // NOTE: the prefix length is inlined as a *number* in the arithmetic
  // below. `SUBSTRING(tag FROM $1)` cannot be used here — Postgres reads a
  // parameterised "FROM" argument as a regular expression and silently
  // returns NULL instead of the tail of the tag.
  const highest = await tx.$queryRaw<
    Array<{ maxNumber: number | bigint | null }>
  >`
      SELECT COALESCE(MAX(CAST(RIGHT("assetTag", LENGTH("assetTag") - ${ASSET_TAG_PREFIX.length}) AS INTEGER)), 0) AS "maxNumber"
      FROM "Asset"
      WHERE "assetTag" LIKE ${`${ASSET_TAG_PREFIX}%`}
    `;

  const fromCounter = Number(counter[0]?.value ?? 0);
  const fromTable = Number(highest[0]?.maxNumber ?? 0);
  const nextNumber =
    Math.max(
      Number.isFinite(fromCounter) ? fromCounter : 0,
      Number.isFinite(fromTable) ? fromTable : 0,
    ) + count;

  // Persist the new high-water mark in the caller's transaction: if the asset
  // insert fails, the counter rolls back with it and no number is burned.
  await tx.assetTagCounter.update({
    where: { id: 1 },
    data: { value: BigInt(nextNumber) },
  });

  return Array.from(
    { length: count },
    (_, i) =>
      `${ASSET_TAG_PREFIX}${String(nextNumber - count + i + 1).padStart(ASSET_TAG_PAD, '0')}`,
  );
}
