import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { AssetCondition } from '@prisma/client';
export interface ImportRow {
  name: string;
  categoryId: string;
  serialNumber?: string;
  location?: string;
  condition: AssetCondition;
  isBookable: boolean;
}
export interface RowError {
  row: number;
  field: string;
  message: string;
}
const COLUMNS = [
  'name',
  'categoryId',
  'serialNumber',
  'location',
  'condition',
  'isBookable',
];
/** Bounded, strict RFC-style CSV; never execute spreadsheet formulas. */
export function parseAssetsCsv(csv: string): {
  rows: ImportRow[];
  errors: RowError[];
} {
  if (!csv || Buffer.byteLength(csv, 'utf8') > 60000)
    throw new BadRequestException('CSV must be between 1 and 60000 bytes');
  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 2048,
      columns: (columns: string[]) => {
        if (
          !columns.includes('name') ||
          !columns.includes('categoryId') ||
          new Set(columns).size !== columns.length ||
          columns.some((c) => !COLUMNS.includes(c))
        )
          throw new Error('Invalid headers');
        return columns;
      },
    });
  } catch {
    throw new BadRequestException(
      'Malformed CSV or headers. Required: name,categoryId; optional: serialNumber,location,condition,isBookable',
    );
  }
  if (!records.length || records.length > 200)
    throw new BadRequestException('CSV must contain 1–200 rows');
  const errors: RowError[] = [];
  const rows = records.map((r, i) => {
    const error = (field: string, message: string) =>
      errors.push({ row: i + 2, field, message });
    for (const field of ['name', 'categoryId'])
      if (!r[field] || r[field].length > 200)
        error(field, 'Required, maximum 200 characters');
    for (const [field, value] of Object.entries(r)) {
      if (
        Array.from(value).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        )
      )
        error(field, 'Control characters are not allowed');
      if (value.length > 200) error(field, 'Maximum 200 characters');
      if (/^[=+@\t\r-]/.test(value))
        error(field, 'Spreadsheet formula prefixes are not allowed');
    }
    if (
      r.condition &&
      !Object.values(AssetCondition).includes(r.condition as AssetCondition)
    )
      error('condition', 'Invalid condition');
    if (r.isBookable && !['true', 'false'].includes(r.isBookable))
      error('isBookable', 'Use true or false');
    return {
      name: r.name,
      categoryId: r.categoryId,
      serialNumber: r.serialNumber || undefined,
      location: r.location || undefined,
      condition: (r.condition || 'GOOD') as AssetCondition,
      isBookable: r.isBookable === 'true',
    };
  });
  return { rows, errors };
}
