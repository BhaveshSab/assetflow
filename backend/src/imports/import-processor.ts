import { PrismaService } from '../prisma/prisma.service';
import { reserveAssetTags } from '../assets/asset-tags';
import type { ImportRow } from './csv';
import { traced } from '../telemetry/tracing';
/** One atomic batch. Redelivery after commit sees DONE, never duplicate assets. */
export async function processImport(
  prisma: PrismaService,
  id: string,
  epoch: number,
) {
  const counted = await prisma.assetImport.updateMany({
    where: {
      id,
      retryEpoch: epoch,
      status: { in: ['PENDING', 'QUEUED'] },
      attempts: { lt: 3 },
    },
    data: { attempts: { increment: 1 } },
  });
  if (!counted.count) {
    await prisma.assetImport.updateMany({
      where: {
        id,
        retryEpoch: epoch,
        status: { in: ['PENDING', 'QUEUED'] },
        attempts: { gte: 3 },
      },
      data: { status: 'FAILED', lastError: 'AttemptLimit', leaseUntil: null },
    });
    return;
  }
  const source = await prisma.assetImport.findUniqueOrThrow({ where: { id } });
  return traced('asset.import.process', source.traceparent, () =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AssetImport" WHERE id=${id} FOR UPDATE`;
        const job = await tx.assetImport.findUniqueOrThrow({ where: { id } });
        if (
          job.retryEpoch !== epoch ||
          !['PENDING', 'QUEUED'].includes(job.status)
        )
          return;
        const owner = await tx.user.findUnique({ where: { id: job.ownerId } });
        const rows = job.rows as unknown as ImportRow[];
        const categories = await tx.assetCategory.count({
          where: {
            id: { in: [...new Set(rows.map((r) => r.categoryId))] },
            status: 'ACTIVE',
          },
        });
        if (
          !owner ||
          owner.status !== 'ACTIVE' ||
          !['ADMIN', 'ASSET_MANAGER'].includes(owner.role) ||
          categories !== new Set(rows.map((r) => r.categoryId)).size
        ) {
          await tx.assetImport.update({
            where: { id },
            data: {
              status: 'FAILED',
              lastError: 'PermissionsOrCategoriesChanged',
              leaseUntil: null,
            },
          });
          return;
        }
        const tags = await reserveAssetTags(tx, rows.length);
        await tx.asset.createMany({
          data: rows.map((r, i) => ({ ...r, assetTag: tags[i] })),
        });
        await tx.activityLog.create({
          data: {
            actorId: job.ownerId,
            action: 'asset.import_completed',
            entityType: 'AssetImport',
            entityId: id,
            metadata: { count: rows.length },
          },
        });
        await tx.assetImport.update({
          where: { id },
          data: {
            status: 'DONE',
            imported: rows.length,
            completedAt: new Date(),
            leaseUntil: null,
            lastError: null,
          },
        });
      },
      { timeout: 30000 },
    ),
  );
}
