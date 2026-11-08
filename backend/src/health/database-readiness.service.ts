import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** SELECT 1 alone cannot detect a new image pointed at an old database schema. */
@Injectable()
export class DatabaseReadinessService {
  constructor(private readonly prisma: PrismaService) {}
  async check(): Promise<{
    database: 'up' | 'down';
    schema: 'current' | 'outdated' | 'unknown';
  }> {
    let columns: { table_name: string; column_name: string }[];
    try {
      columns = await this.prisma.$queryRaw`
        SELECT table_name::text AS table_name, column_name::text AS column_name FROM information_schema.columns
        WHERE table_schema = current_schema()`;
    } catch {
      return { database: 'down', schema: 'unknown' };
    }
    const present = new Set(
      columns.map((c) => `${c.table_name}.${c.column_name}`),
    );
    const matches = Prisma.dmmf.datamodel.models.every((model) =>
      model.fields
        .filter((field) => field.kind !== 'object')
        .every((field) =>
          present.has(
            `${model.dbName || model.name}.${field.dbName || field.name}`,
          ),
        ),
    );
    return { database: 'up', schema: matches ? 'current' : 'outdated' };
  }
}
