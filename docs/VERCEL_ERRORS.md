# Vercel: diagnosing a screen-specific API failure

A successful deployment does not mean the database has the matching schema.
`backend`'s Vercel build runs `prisma generate && nest build`; it deliberately
**does not migrate the database**. Preview builds must not mutate production.

## 1. Find the failing API request, not just the page

1. Open the website, press **F12 → Network**, and reload the failing page.
2. Click the red request (for example `/api/notifications`). Note its status,
   **Response** body, and `x-request-id` response header if present.
3. In Vercel, open the **API/backend project → Logs**, filter to the failure's
   time/path, and inspect the error. The frontend project alone may not have
   the database error. Share the error code and request ID, not cookies,
   authorization headers, database URLs, or the entire environment.

If `/auth/me` and dashboard requests succeed but notifications fail, do not
assume that authentication or the entire database is offline.

### A reproducible notification-specific cause

The outbox migration `20261109090000_booking_job_outbox` adds
`Notification.dedupeKey`. An implicit Prisma `notification.findMany()` selects
this column even though the bell does not use it. A generated client pointed
at the older table then fails with **P2022**. An ordinary notification `create`
can fail for the same reason through its implicit returned columns.

The API now explicitly selects the public feed fields and returns only `id`
from ordinary event writes. This is real read/write compatibility, not an empty
feed fallback. **Queued reminder writes still need the migration.** This is a
reproduced failure mode, not confirmation of any particular live deployment's
cause; check its logs/database first.

If the deployment uses Neon, its SQL Editor can run this **read-only** check
against the same database/branch used by the backend:

```sql
SELECT current_database(), current_schema();
SELECT column_name
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'Notification'
ORDER BY ordinal_position;
```

A missing `dedupeKey` supports this diagnosis. A missing table or another error
needs its own investigation. Do not paste ad hoc `ALTER TABLE` commands to
bypass migration history.

## 2. Apply the reviewed release's migrations (browser-only option)

Only migrate the database after confirming the target, reviewing the release's
pending migrations, and arranging a backup/recovery point. Apply migrations
from the **exact reviewed release being deployed**, not an unrelated preview.
Do not use `prisma migrate reset` or `prisma db push` against production.

If you have no local checkout:

1. Open the reviewed release on GitHub and use **Code → Codespaces → Create
   codespace**. Verify the checked-out revision matches the approved release.
2. Open its terminal and run `cd backend && npm ci`.
3. Obtain the database's **direct/unpooled** connection URL in your database
   provider's connection dialog. It must refer to the same database and branch
   as the API's pooled runtime URL.
4. Enter it through a hidden prompt, not a literal command saved in history:

   ```bash
   read -rsp 'Direct database URL: ' DATABASE_URL_UNPOOLED; echo
   export DATABASE_URL_UNPOOLED
   npm run prisma:migrate
   unset DATABASE_URL_UNPOOLED
   ```

   `prisma:migrate` runs `prisma migrate deploy`, using the direct URL for that
   subprocess. If it fails, stop and inspect the failure; do not mark migrations
   applied manually. Delete/stop the codespace when finished.

Vercel **backend** environment variable shapes (enter real values only in the
provider's private settings):

| Variable | Shape / purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql://<user>:<password>@<runtime-host>/<database>?sslmode=require` — runtime connection; a pooled Neon host typically includes `-pooler` |
| `DATABASE_URL_UNPOOLED` | `postgresql://<user>:<password>@<direct-host>/<database>?sslmode=require` — same database, direct host, migration use only; configuring it does not itself execute migrations |

Do not add database credentials to the frontend or any `VITE_*` variable.
Production and Preview should use appropriately isolated databases.

## 3. Deploy and verify

After the approved code and migrations are ready, deploy the **backend**, then
any frontend changes. Confirm the frontend actually calls that API deployment.
The updated API provides:

- `/api/health`: HTTP 200 liveness; the body can say `degraded`.
- `/api/health/ready`: HTTP **503** if configuration, database connectivity, or
  required table/column availability is not ready; HTTP 200 when ready.
- Missing table/column errors: HTTP 503, code `DATABASE_SCHEMA_NOT_READY`, and
  a request reference, rather than an unexplained 500.

Readiness checks table/column availability, not every possible index, type,
constraint, or external integration. It does not replace migration review.
Log in and confirm `/api/notifications` returns actual items/unread counts,
marking read works, and the other originally failing requests succeed. A green
build or health endpoint alone does not establish that those screens work.
