# Phases 2–5: private files, background imports, QR and tracing

This is implementation/rollout documentation, **not a claim of a production
rollout**. These features add to the modular NestJS/Postgres application and
existing dedicated BullMQ worker. No new always-on production service is required.

## 2. Private S3 attachments

**UI:** Asset Directory → an asset's **Files & QR label** → upload/download/remove.
Any signed-in user can also use **Scan / look up an asset** (`/scan`) to open
an asset and its files. This matches existing organization-wide asset read access;
this app is not a multi-tenant document vault. ADMIN/ASSET_MANAGER can write.

1. API validates filename, allowed content type, declared size (1 byte–5 MiB),
   SHA-256 and the asset. Limit: 100 pending/ready files per asset.
2. It creates an opaque, random object key and a **120-second** signed PUT.
   The signature binds content length, content type, checksum, encryption and
   `If-None-Match: *`. The browser uploads directly to S3, without its API JWT.
3. Completion verifies stored size/type/checksum, a basic file signature and a
   non-null S3 version ID. The bucket **must have versioning enabled**. Completion
   is idempotent; unverified/expired uploads cannot be downloaded.
4. Metadata listing never returns object keys, checksums or public URLs. Download
   authorization issues a **60-second**, version-pinned, attachment-disposition
   URL, served as octet-stream with private/no-store caching. Reusing an old PUT
   cannot change an already-verified version. Signed URLs are bearer capabilities:
   do not share them; authorization is checked when they are issued.
5. Remove is an audited logical deletion: it prevents future URL issuance, not
   erasure of S3 versions. An already-issued URL can work until expiry. Retain or
   purge objects according to an approved retention policy. Pending objects and
   old metadata are **not automatically garbage-collected** in this release.

Allowed: PDF, PNG, JPEG and plain text. Basic signature checks are **not antivirus
scanning**. Files are never rendered inline. Existing external `documents` links
remain unchanged; this does not silently migrate public legacy links into S3.

### Storage setup

Use a dedicated private bucket (not the database backup bucket). Enable:
- Block Public Access, bucket-owner-enforced object ownership, versioning,
  default SSE-S3 encryption and a bucket policy requiring TLS.
- An instance/task role or securely injected credentials. Never expose AWS
  credentials to the SPA. Grant only `s3:PutObject`, `s3:GetObject` and
  `s3:GetObjectVersion` on `arn:aws:s3:::YOUR-BUCKET/attachments/*`.
  Version deletion is an operator/test-cleanup permission, not an API permission.
- Review how the container obtains role credentials; do not casually expose the
  host metadata service or broaden the role just to make an SDK call work.

Bucket CORS (replace the origin with the exact SPA origin; no `*`):

```json
[{
  "AllowedOrigins": ["https://YOUR-FRONTEND.example"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type", "if-none-match", "x-amz-checksum-sha256", "x-amz-server-side-encryption"],
  "ExposeHeaders": ["ETag", "x-amz-version-id"],
  "MaxAgeSeconds": 300
}]
```

Set **backend only** (Vercel project variables or `infra/.env`):

| Variable | Value shape |
|---|---|
| `ATTACHMENTS_ENABLED` | `true` (unset/false disables new signing) |
| `ATTACHMENTS_BUCKET` | bucket name only, without `s3://` |
| `AWS_REGION` | actual bucket region, e.g. `ap-southeast-2` |

Use the AWS default credential chain. For a platform without a workload role,
store scoped `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, if temporary,
`AWS_SESSION_TOKEN` only in that platform's secret settings. Prefer short-lived
credentials; never put them in a `VITE_` variable. No new frontend secret is needed.

**Routes:** `GET/POST /assets/:assetId/attachments`,
`POST .../:id/complete`, `POST .../:id/download`, `DELETE .../:id`.
Missing storage configuration returns a readable 503; it does not prevent API boot.

## 3. Validated background CSV import

**UI:** Asset Directory → **Import assets from CSV**. Managers/admins only.
Upload or paste CSV, validate, inspect the preview/errors, then explicitly confirm.
The modal shows recent job status/counts, cancellation, retry and refresh controls.

Required headers: `name,categoryId`. Optional: `serialNumber,location,condition,isBookable`.
Expand **Category IDs for your CSV** in the import dialog to select/copy an active category ID.

```csv
name,categoryId,serialNumber,location,condition,isBookable
"Laptop, meeting room",REPLACE_WITH_ACTIVE_CATEGORY_ID,SN-100,HQ,GOOD,true
```

Limits: 60,000 UTF-8 bytes, 200 rows, 200 characters per field, strict header/column
counts, valid enums/booleans, no control characters or spreadsheet formula prefixes.
Quoted fields, escaped quotes, BOM and CRLF are supported. API request-body limits
also apply. Errors identify CSV record and field (record numbering, not physical
lines inside quoted multiline fields). Invalid previews do not create jobs/assets.
At most 20 unfinished jobs/previews per user; cancel unused drafts.

Valid previews persist immutable normalized rows in Postgres, expire for confirmation
after 24 hours, and create **no assets** until confirmed. Confirmation needs
`JOBS_ENABLED=true` plus the existing `jobs` profile/worker/dedicated jobs Redis.
This flag also moves booking reminders to the worker; follow BACKGROUND_JOBS.md,
including consistent API/worker settings and memory review. Do not just enable it
on a small production host without checking capacity.

The publisher claims five-minute leases in bounded batches; only ID/epoch enter
Redis. A separate BullMQ import queue has concurrency 1 and three attempts with
exponential backoff. Each at-most-200-row batch locks the job and shared tag counter,
rechecks the active owner/role and categories, creates all assets and the activity
record, and commits DONE **in one database transaction**. Failed inserts roll back
the entire batch/counter. Redelivery cannot duplicate a completed job. Manual retry
increments an epoch so stale deliveries cannot execute the new attempt. Cancellation
and execution serialize on the same row. Queue loss can be recovered from leases.

This is job-level deduplication, not file-level deduplication: deliberately confirming
a second preview of the same CSV creates another batch. There is no partial-success
mode, arbitrary status import, automatic admin creation or cross-user job access
(except ADMIN inspection). Old preview/job rows require an approved retention policy.

**Routes:** `POST /asset-imports/preview`, `GET /asset-imports`, `GET /asset-imports/:id`,
`POST /asset-imports/:id/{confirm,cancel,retry}`. Statuses:
DRAFT → PENDING → QUEUED → DONE / FAILED; cancellation → CANCELLED.

## 4. QR lookup and audit scanning

**UI:** Download a PNG QR label from Files & QR. Scan at `/scan`, or inside an
open audit's Continue Audit panel. Assigned employees can open **My assigned open audits** on `/scan`; the API returns only their own open assignments. Camera access is explicit and stops on close;
HTTPS/camera permission is needed. Manual entry is always available.

Payload: `assetflow:AF-0001`. It is an identifier, **not authentication**, an access
token or an arbitrary URL. The scanner never navigates untrusted scanned URLs.
`GET /assets/lookup/by-tag?tag=AF-0001` still requires an active signed-in user.

`POST /audits/:id/scan` with `{ "tag": "AF-0001" }` resolves an item only for a
manager or an assigned auditor, only within that open cycle. It does **not** mark
anything. The user explicitly confirms VERIFIED / MISSING / DAMAGED using the
existing protected mark endpoint. Existing activity/discrepancy notifications are
preserved. Closing and marking serialize on a cycle lock. A QR label cannot bypass
assignment checks or reopen a closed audit. Physical camera hardware needs a real
browser check; simulated tests are not proof of a phone camera working.

## 5. OpenTelemetry tracing

Opt-in, bounded OTLP/HTTP export. Initialization runs before Prisma in API, Vercel
and worker entrypoints. Nest spans use route templates, propagate W3C trace context,
return `x-trace-id` (exposed through CORS) and correlate JSON request logs. PostgreSQL
TCP-driver spans are enabled with a parent span. Neon WebSocket query instrumentation
is **not** claimed. Reminder/import rows retain only traceparent; worker spans
continue that trace across delayed delivery and restart.

An export allowlist strips SQL/parameters, request bodies, tokens, signed URLs,
exception messages/events, process arguments and link attributes. Default root
sampling: 10%, with parent-based sampling; a sampled incoming parent remains sampled.
Queue: 256 spans, batch: 64, export timeout: 3 seconds. Trace loss during outage or
process termination is acceptable; traces are not the durable audit log. Serverless
responses trigger a bounded best-effort flush; long-running processes shut down the
SDK on termination. Export failures must not change a business transaction's result.

| Backend/worker variable | Value shape |
|---|---|
| `OTEL_ENABLED` | `true`; unset/false disables tracing |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | full collector URL ending `/v1/traces` |
| `OTEL_TRACE_SAMPLE_RATIO` | decimal 0–1; default `0.1` |
| `OTEL_SERVICE_NAME` | `assetflow-api` or `assetflow-worker` |
| `OTEL_EXPORTER_OTLP_HEADERS` | optional secret header settings for managed OTLP |

Never point exporter URLs at browser localhost. Invalid tracing configuration disables
tracing with a generic warning. Keep credentials in secret settings. The worker's
base network is internal: managed external export needs an approved egress collector
or network design, not a blind assumption that an internet URL is reachable.

### Optional private Jaeger viewer

`infra/docker-compose.tracing.yml` supplies an explicitly selected, pinned Jaeger
2.11 backend, bounded to 1,000 **in-memory** traces / 256 MiB container memory.
Traces are lost on restart/eviction. UI binds only host loopback; OTLP stays private.
Do not open ports 4318/16686 publicly. Review capacity before using this on a 1 GiB host.

From the repository root, after normal deployment/configuration:

```sh
docker compose -f infra/docker-compose.yml -f infra/docker-compose.tracing.yml --profile jobs config --quiet
docker compose -f infra/docker-compose.yml -f infra/docker-compose.tracing.yml up -d jaeger api
# Only if jobs are intentionally enabled:
docker compose -f infra/docker-compose.yml -f infra/docker-compose.tracing.yml --profile jobs up -d worker
```

Overlay selection is explicit: the normal deploy script does **not** automatically
start/enable this overlay. For ongoing automation use the backend/worker OTEL env
settings with a separately managed collector, or explicitly manage the overlay on
each rollout. Vercel cannot reach private EC2 Docker DNS: use a managed HTTPS collector
there, not `http://jaeger:4318`.

For browser-only EC2 verification without publishing the viewer, query it through
an existing API container after making a sampled authenticated API request:

```sh
docker compose -f infra/docker-compose.yml exec -T api node -e \
  "fetch('http://jaeger:16686/api/services').then(r=>r.json()).then(console.log)"
```

A listed service is discovery evidence only; query the returned trace ID and verify
API/worker parent-child spans to prove correlation. Use a secure tunnel to view the UI.

## Tests and rollout boundary

- New HTTP/database e2e suite uses the actual migrated PostgreSQL-compatible test DB,
  real guards, DTO validation, transactions and processors; S3 boundary is mocked.
- Real disposable Redis/BullMQ suite executes a confirmed import through publisher
  and worker, and existing reminder recovery/retry tests continue to run.
- Trace e2e uses a real local OTLP/HTTP receiver, validates API → persisted job →
  worker parentage, error status and secret redaction. CI additionally starts the
  actual Jaeger image/config, ingests a synthetic OTLP span and queries it back.
- Frontend interaction tests cover signed upload/completion, preview/confirmation,
  manual QR/camera-denied fallback and explicit audit marking. Built bundle smoke
  guards lazy QR chunks against dependency cycles.
- `attachments-s3.e2e-spec.ts` is deliberately skipped unless
  `TEST_ATTACHMENTS_BUCKET` is supplied. Use a **dedicated versioned test bucket**,
  `AWS_REGION`, secure AWS credentials and optional `TEST_ATTACHMENTS_ORIGIN` to
  test real PUT/replay protection, verification, download/privacy and CORS.
  Test cleanup needs version-deletion permission; it deletes only exact versions
  recorded in its isolated test DB. Interrupted/failed tests may need orphan cleanup.

In a Codespace/dev terminal (never supply production DATABASE_URL):

```sh
cd backend
npm ci
npx prisma generate
npm run test:unit -- --runInBand
# PGlite migrations run automatically; TEST_JOBS_REDIS_URL must be disposable.
npm run test:e2e -- --runInBand
# After securely setting the dedicated bucket variables above:
npm run test:e2e -- --runInBand attachments-s3.e2e-spec.ts
```

Apply the new additive Prisma migration through the existing migration deployment
process. No destructive reset or public-file migration is required. Before claiming
production completion, verify the actual bucket IAM/versioning/CORS, a browser
upload/download, enabled worker import, physical-camera/manual audit flow, and a
trace in the chosen deployment collector. No such live AWS rollout is asserted here.
