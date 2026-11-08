#!/usr/bin/env python3
"""Prove the restore constraint check against a real PostgreSQL instance.

This runs the *shipped* SQL file, not a copy, against a database built by the
*shipped* Prisma migrations. It answers three questions the unit tests cannot:

  1. Do pg_get_constraintdef / pg_get_indexdef really render the way the
     canonicalizer assumes (identifier quoting included)?
  2. Does the canonicalized comparison actually evaluate to true on a correct
     database?
  3. Does each individual assertion still fail when the object it guards is
     missing or weakened? A check that cannot fail is not a check.

Exit status is 0 only if every case behaves as stated.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CHECK_SQL = os.path.join(REPO, 'infra', 'scripts', 'lib', 'restore-constraints.sql')

PG = ['psql', '-v', 'ON_ERROR_STOP=1', '-tA', '-X', '-q']
BASE = os.environ.get('RESTORE_TEST_DB_URL')
if not BASE:
    sys.exit('RESTORE_TEST_DB_URL is required')


def psql(sql, url=BASE):
    """Run SQL on the given database and return stripped stdout; raise on failure."""
    result = subprocess.run(
        PG + [url, '-f', '-'],
        input=sql, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f'psql failed: {result.stderr.strip()}\nSQL: {sql[:400]}')
    return result.stdout.strip()


def run_check(url):
    """Evaluate the shipped check file. Returns 't' or 'f'."""
    return psql(open(CHECK_SQL).read(), url=url)


def main():
    problems = []
    passed = 0

    def expect(label, actual, wanted):
        nonlocal passed
        if actual == wanted:
            passed += 1
            print(f'  ok   {label} -> {actual}')
        else:
            problems.append(f'{label}: got {actual!r}, wanted {wanted!r}')
            print(f'  FAIL {label} -> {actual!r} (wanted {wanted!r})')

    print('== 1. the check passes on a database built by the real migrations ==')
    expect('shipped check on migrated schema', run_check(BASE), 't')

    print('== 2. the rendered definitions, as PostgreSQL actually formats them ==')
    rendered = psql(r"""
        SELECT pg_get_constraintdef(oid)
        FROM pg_constraint WHERE conname = 'Booking_no_overlap'""")
    print(f'  raw Booking_no_overlap: {rendered}')
    if '"assetId"' not in rendered or '"status"' not in rendered:
        problems.append('expected quoted identifiers in the rendered EXCLUDE definition')
    if '::"BookingStatus"' not in rendered:
        problems.append('expected the enum cast in the rendered EXCLUDE definition')

    idx = psql(r"""
        SELECT pg_get_expr(indpred, indrelid) FROM pg_index
        WHERE indexrelid = to_regclass('public."Allocation_one_active_per_asset"')""")
    print(f'  raw allocation predicate: {idx}')
    if '"status"' not in idx:
        problems.append('expected a quoted column in the rendered index predicate')

    print('== 3. each assertion still fails when its object is weakened ==')
    # Work on private scratch databases so the good database stays good.
    for label, mutate, restore in (
            ('EXCLUDE constraint dropped',
             'ALTER TABLE "Booking" DROP CONSTRAINT "Booking_no_overlap"',
             'ALTER TABLE "Booking" ADD CONSTRAINT "Booking_no_overlap" EXCLUDE USING gist '
             '("assetId" WITH =, tsrange("startTime","endTime") WITH &&) WHERE ("status" <> \'CANCELLED\')'),
            ('EXCLUDE predicate widened (CANCELLED included)',
             'ALTER TABLE "Booking" DROP CONSTRAINT "Booking_no_overlap"; '
             'ALTER TABLE "Booking" ADD CONSTRAINT "Booking_no_overlap" EXCLUDE USING gist '
             '("assetId" WITH =, tsrange("startTime","endTime") WITH &&)',
             'ALTER TABLE "Booking" DROP CONSTRAINT "Booking_no_overlap"; '
             'ALTER TABLE "Booking" ADD CONSTRAINT "Booking_no_overlap" EXCLUDE USING gist '
             '("assetId" WITH =, tsrange("startTime","endTime") WITH &&) WHERE ("status" <> \'CANCELLED\')'),
            ('CHECK constraint dropped',
             'ALTER TABLE "Booking" DROP CONSTRAINT "Booking_time_order"',
             'ALTER TABLE "Booking" ADD CONSTRAINT "Booking_time_order" CHECK ("endTime" > "startTime")'),
            ('partial unique index dropped',
             'DROP INDEX "Allocation_one_active_per_asset"',
             'CREATE UNIQUE INDEX "Allocation_one_active_per_asset" ON "Allocation" ("assetId") '
             "WHERE \"status\" = 'ACTIVE'"),
            ('unique index made non-unique',
             'DROP INDEX "Allocation_one_active_per_asset"; '
             'CREATE INDEX "Allocation_one_active_per_asset" ON "Allocation" ("assetId") '
             "WHERE \"status\" = 'ACTIVE'",
             'DROP INDEX "Allocation_one_active_per_asset"; '
             'CREATE UNIQUE INDEX "Allocation_one_active_per_asset" ON "Allocation" ("assetId") '
             "WHERE \"status\" = 'ACTIVE'"),
            ('btree_gist extension removed',
             'ALTER TABLE "Booking" DROP CONSTRAINT "Booking_no_overlap"; DROP EXTENSION btree_gist',
             'CREATE EXTENSION IF NOT EXISTS btree_gist; '
             'ALTER TABLE "Booking" ADD CONSTRAINT "Booking_no_overlap" EXCLUDE USING gist '
             '("assetId" WITH =, tsrange("startTime","endTime") WITH &&) WHERE ("status" <> \'CANCELLED\')'),
    ):
        psql(mutate)
        expect(label, run_check(BASE), 'f')
        psql(restore)

    print('== 4. a correct database is accepted again after the restores ==')
    expect('shipped check after undo', run_check(BASE), 't')

    print()
    print(f'passed {passed} assertions, {len(problems)} problems')
    for problem in problems:
        print(f'  - {problem}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
