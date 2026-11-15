#!/usr/bin/env python3
"""Emit read-only SQL matching Prisma's successful history to release SQL bytes."""
import hashlib
from pathlib import Path
import re
import sys


def history_sql(root):
    migrations = sorted(p for p in Path(root).iterdir() if p.is_dir())
    if not migrations:
        raise ValueError('migration history is empty')
    values = []
    for folder in migrations:
        if not re.fullmatch(r'[A-Za-z0-9_]+', folder.name):
            raise ValueError('invalid migration directory name')
        checksum = hashlib.sha256((folder / 'migration.sql').read_bytes()).hexdigest()
        values.append(f"('{folder.name}', '{checksum}')")
    return '''WITH expected(name, checksum) AS (VALUES
''' + ',\n'.join(values) + '''
), applied AS (
 SELECT migration_name AS name, checksum FROM "_prisma_migrations"
 WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
)
SELECT NOT EXISTS (
 (SELECT * FROM expected EXCEPT SELECT * FROM applied)
 UNION ALL
 (SELECT * FROM applied EXCEPT SELECT * FROM expected)
) AND NOT EXISTS (
 SELECT 1 FROM "_prisma_migrations"
 WHERE finished_at IS NULL AND rolled_back_at IS NULL
) AND NOT EXISTS (SELECT name FROM applied GROUP BY name HAVING count(*) <> 1);
'''


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('migration directory required')
        print(history_sql(sys.argv[1]))
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
