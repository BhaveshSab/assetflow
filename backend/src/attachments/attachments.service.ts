import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/jwt.strategy';
import type { UploadAttachmentDto } from './attachments.controller';
import { ObjectStore } from './object-store';
const PUBLIC = {
  id: true,
  filename: true,
  contentType: true,
  size: true,
  createdAt: true,
} as const;

export function validSignature(type: string, bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (type === 'application/pdf')
    return b.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (type === 'image/png')
    return b
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg')
    return b[0] === 255 && b[1] === 216 && b[2] === 255;
  return type === 'text/plain' && !b.includes(0);
}
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ObjectStore,
    private readonly activity: ActivityService,
  ) {}
  private async asset(id: string) {
    if (
      !(await this.prisma.asset.findUnique({
        where: { id },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Asset not found');
  }
  async list(assetId: string) {
    await this.asset(assetId);
    return this.prisma.attachment.findMany({
      where: { assetId, status: 'READY' },
      select: PUBLIC,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  async begin(assetId: string, dto: UploadAttachmentDto, user: AuthUser) {
    await this.asset(assetId);
    const extensions: Record<string, RegExp> = {
      'application/pdf': /\.pdf$/i,
      'image/png': /\.png$/i,
      'image/jpeg': /\.jpe?g$/i,
      'text/plain': /\.txt$/i,
    };
    if (!extensions[dto.contentType]?.test(dto.filename))
      throw new BadRequestException(
        'Filename extension must match the allowed content type',
      );
    const objectKey = `attachments/${assetId}/${randomUUID()}`;
    const uploadUrl = await this.store.upload(
      objectKey,
      dto.contentType,
      dto.checksum,
      dto.size,
    );
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Asset" WHERE id=${assetId} FOR UPDATE`;
      const existing = await tx.attachment.count({
        where: { assetId, status: { in: ['PENDING', 'READY'] } },
      });
      if (existing >= 100)
        throw new BadRequestException(
          'Maximum 100 active or pending attachments per asset',
        );
      return tx.attachment.create({
        data: {
          ...dto,
          assetId,
          uploadedById: user.id,
          objectKey,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
    });
    return {
      id: row.id,
      uploadUrl,
      expiresIn: 120,
      headers: {
        'Content-Type': dto.contentType,
        'x-amz-checksum-sha256': dto.checksum,
        'If-None-Match': '*',
        'x-amz-server-side-encryption': 'AES256',
      },
    };
  }
  private async row(assetId: string, id: string) {
    const row = await this.prisma.attachment.findFirst({
      where: { id, assetId, status: { not: 'DELETED' } },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    return row;
  }
  async complete(assetId: string, id: string, user: AuthUser) {
    const row = await this.row(assetId, id);
    if (row.status === 'READY') return { id: row.id, status: row.status };
    if (row.expiresAt < new Date())
      throw new ConflictException('Upload expired; start a new upload');
    const head = await this.store.inspect(row.objectKey).catch(() => {
      throw new BadRequestException('Uploaded object could not be verified');
    });
    if (
      head.size !== row.size ||
      head.type !== row.contentType ||
      head.checksum !== row.checksum ||
      !head.version ||
      head.version === 'null' ||
      !head.bytes ||
      !validSignature(row.contentType, head.bytes)
    )
      throw new BadRequestException(
        'Object size, type, checksum, signature or bucket versioning is invalid',
      );
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.attachment.updateMany({
        where: { id, assetId, status: 'PENDING' },
        data: { status: 'READY', versionId: head.version },
      });
      if (changed.count)
        await this.activity.log(
          {
            actorId: user.id,
            action: 'attachment.created',
            entityType: 'Asset',
            entityId: assetId,
            metadata: { attachmentId: id },
          },
          tx,
        );
      else if (
        !(await tx.attachment.findFirst({ where: { id, status: 'READY' } }))
      )
        throw new ConflictException('Attachment changed during verification');
      return { id, status: 'READY' };
    });
  }
  async download(assetId: string, id: string) {
    const row = await this.row(assetId, id);
    if (row.status !== 'READY' || !row.versionId)
      throw new ConflictException('Attachment is not verified');
    return {
      url: await this.store.download(
        row.objectKey,
        row.versionId,
        row.filename,
      ),
      expiresIn: 60,
    };
  }
  async remove(assetId: string, id: string, user: AuthUser) {
    await this.row(assetId, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.attachment.update({
        where: { id },
        data: { status: 'DELETED' },
      });
      await this.activity.log(
        {
          actorId: user.id,
          action: 'attachment.deleted',
          entityType: 'Asset',
          entityId: assetId,
          metadata: { attachmentId: id },
        },
        tx,
      );
      return { id, status: 'DELETED' };
    });
  }
}
