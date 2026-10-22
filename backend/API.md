# AssetFlow API Reference

> **Living contract for the whole team.** Frontend engineers: build against this.
> Base URL: `http://localhost:4000/api`
> (port 4000 — 3000 was taken by another local project.)

## Conventions

- **Auth:** send the JWT as `Authorization: Bearer <token>` on every protected
  route. Get the token from `/auth/signup` or `/auth/login`.
- **Content type:** `application/json` (except the CSV export, which returns `text/csv`).
- **Errors:** non-2xx look like `{ "statusCode": 409, "message": "...", "error": "Conflict" }`.
  The allocation-conflict 409 additionally includes `currentHolder`, `currentDepartment`, `currentAllocationId`.
- **List endpoints** return `{ items: [...], total: number }`. Common query params: `take`/`skip` (or `page`/`limit`/`pageSize`), plus per-resource filters. Page size is capped at 200.
- **IDs** are opaque strings (cuid). **Dates** are ISO 8601 strings.
- **Roles:** `ADMIN`, `ASSET_MANAGER`, `DEPARTMENT_HEAD`, `EMPLOYEE`. "any auth" = any logged-in user.
- **Enums** (from `schema.prisma`): `AssetStatus` = AVAILABLE · ALLOCATED · RESERVED · UNDER_MAINTENANCE · LOST · RETIRED · DISPOSED; `AssetCondition` = NEW · GOOD · FAIR · POOR · DAMAGED; `MaintenancePriority` = LOW · MEDIUM · HIGH · CRITICAL; `AllocationStatus` = ACTIVE · RETURNED; `BookingStatus` = UPCOMING · ONGOING · COMPLETED · CANCELLED; `MaintenanceStatus` = PENDING · APPROVED · REJECTED · TECHNICIAN_ASSIGNED · IN_PROGRESS · RESOLVED.
- **Unknown body fields are rejected** (`400`) — the global `ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`.
- **Rate limits:** `429` with `{ statusCode, message }` when the global limiter (per IP) or the sign-in limiter (per account + IP) trips.

### Row-level scoping

| Caller | Sees |
|--------|------|
| `ADMIN`, `ASSET_MANAGER` | everything |
| `DEPARTMENT_HEAD` | their own department (allocations, bookings, maintenance) |
| `EMPLOYEE` | only their own allocations, bookings and maintenance requests |

The scoping is implemented in `src/common/auth/scopes.ts` and applied by the
allocations, maintenance, bookings and reports services. A resource that
belongs to somebody else answers **404** (not 403) so its existence is not
disclosed.

---

## Auth ✅

| Method | Path | Roles | Body / notes |
|---|---|---|---|
| POST | `/auth/signup` | public | `{ name, email, password }` → `{ token, user }`. Always creates an **EMPLOYEE** — a caller can never self-assign a role. Password ≥ 8 chars. |
| POST | `/auth/login` | public | `{ email, password }` → `{ token, user }`. E-mail matching is case-insensitive. Unknown account and wrong password return the **same** message after the same amount of work. Repeated failures are throttled (`429`). |
| GET | `/auth/me` | any auth | → current `{ id, name, email, role, departmentId }`. A deactivated account's token stops working immediately. |

`user` shape everywhere: `{ id, name, email, role, status, departmentId }`. **passwordHash is never returned.**

## Organization Setup (#3) ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/org/departments` | ADMIN | `{ name, headId?, parentDepartmentId?, status? }`. Dupe name → 409; parent cycle → 400. |
| GET | `/org/departments` | any auth | filters `q`, `status`. |
| GET | `/org/departments/:id` | any auth | incl head, parent, children, member count. |
| PATCH | `/org/departments/:id` | ADMIN | edit name/head/parent/status. |
| POST | `/org/categories` | ADMIN | `{ name, customFields?, status? }`. |
| GET | `/org/categories` | any auth | filters `q`, `status`; incl asset count. |
| GET | `/org/categories/:id` | any auth | |
| PATCH | `/org/categories/:id` | ADMIN | |
| GET | `/org/employees` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | filters `q`, `departmentId`, `role`, `status`. |
| GET | `/org/employees/directory` | any auth | minimal `{ id, name, email }` list — used for pickers. |
| GET | `/org/employees/:id` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | |
| POST | `/org/employees` | ADMIN | `{ name, email, password?, role?, departmentId? }`. Returns a **temporary password** when none is supplied. |
| PATCH | `/org/employees/:id` | ADMIN | edit name, departmentId, status. Can't deactivate the last active admin (409). |
| PATCH | `/org/employees/:id/role` | ADMIN | `{ role }`. **The only place roles change.** Can't demote the last admin (409). |

## Assets (#4) ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/assets` | ADMIN, ASSET_MANAGER | `{ name, categoryId, serialNumber?, acquisitionDate?, acquisitionCost?, condition?, location?, photoUrl?, documents?, isBookable?, customFieldValues? }`. Auto tag `AF-0001` (numeric, so `AF-9999` is followed by `AF-10000`). |
| GET | `/assets` | any auth | filters `q` (tag/serial/name — a QR scan yields the tag), `categoryId`, `status`, `location`, `isBookable`, `take`, `skip`. |
| GET | `/assets/:id` | any auth | detail incl category + current holder. |
| GET | `/assets/:id/history` | any auth | `{ allocations: [...], maintenance: [...] }`. |
| PATCH | `/assets/:id` | ADMIN, ASSET_MANAGER | edit fields; may set RETIRED/DISPOSED/LOST. Manual ALLOCATED/UNDER_MAINTENANCE/RESERVED → 400 (owned by workflows). Setting **AVAILABLE** while the asset is allocated or has an open maintenance request → 400. |

`documents` must be an array of `{ name, url }` (http(s) URL or root-relative path, ≤ 20 entries);
`customFieldValues` must be a flat object of scalar values (≤ 50 entries). Anything else → 400.

## Allocation & Transfer (#5) ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/allocations` | ADMIN, ASSET_MANAGER | `{ assetId, holderUserId? \| departmentId?, expectedReturnDate? }`. **Conflict:** already-held → 409 (with current holder). Row-locked against races. Inactive holders/departments → 400. |
| POST | `/allocations/:id/return` | any auth (scoped) | `{ checkInNotes?, conditionOnReturn? }` → asset back to AVAILABLE (stays UNDER_MAINTENANCE while a request is open). A department head may only return their own department's allocations, an employee only their own. |
| GET | `/allocations` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | filters `assetId`, `holderUserId`, `departmentId`, `status`, `overdue`. |
| GET | `/allocations/my` | any auth | the caller's own allocations. |
| GET | `/allocations/overdue` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | past expected return date. |
| POST | `/transfers` | any auth (scoped) | `{ assetId, toUserId? \| toDepartmentId?, reason? }` (asset must be currently held). A department head may only transfer assets their department holds. |
| POST | `/transfers/:id/approve` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | atomically re-allocates to the target. |
| POST | `/transfers/:id/reject` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | |
| GET | `/transfers` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | filters `status`, `assetId`. |

## Resource Booking (#6) ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/bookings` | any auth | `{ assetId, startTime, endTime, purpose? }`. Asset must be `isBookable` & in service. **Start time must be in the future** → 400 otherwise; `endTime` before `startTime` → 400. **Overlap → 409** (touching boundaries allowed). Row-locked. |
| GET | `/bookings` | any auth | filters `assetId`, `status`, `from`, `to` (calendar), `mine`. Each item has a derived `effectiveStatus` (UPCOMING/ONGOING/COMPLETED/CANCELLED). |
| GET | `/bookings/my` | any auth | the caller's own bookings. |
| GET | `/bookings/:id` | booker or ADMIN/ASSET_MANAGER | somebody else's booking → **404**. |
| POST | `/bookings/:id/cancel` | booker or ADMIN/ASSET_MANAGER | completed/cancelled bookings → 409. |
| PATCH | `/bookings/:id/reschedule` | booker or ADMIN/ASSET_MANAGER | `{ startTime, endTime }` — re-validates overlap and the future rule. |

## Maintenance (#7) ✅

State machine: `PENDING → APPROVED/REJECTED → TECHNICIAN_ASSIGNED → IN_PROGRESS → RESOLVED` (invalid jumps → 409).

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/maintenance` | any auth | `{ assetId, description, priority?, photoUrl? }`. An asset that is OUT_OF_SERVICE cannot be sent to maintenance → 400. |
| POST | `/maintenance/:id/approve` | ADMIN, ASSET_MANAGER | asset → UNDER_MAINTENANCE. Approving twice → 409. |
| POST | `/maintenance/:id/reject` | ADMIN, ASSET_MANAGER | |
| POST | `/maintenance/:id/assign` | ADMIN, ASSET_MANAGER | `{ technicianName }`. |
| POST | `/maintenance/:id/start` | ADMIN, ASSET_MANAGER | |
| POST | `/maintenance/:id/resolve` | ADMIN, ASSET_MANAGER | `{ resolutionNotes? }`. Asset → AVAILABLE (or back to ALLOCATED if still held). |
| GET | `/maintenance` | any auth (scoped) | filters `assetId`, `status`, `priority`, `mine`. An employee only sees their own requests, a department head their department's. |
| GET | `/maintenance/my` | any auth | the caller's own requests. |
| GET | `/maintenance/:id` | any auth (scoped) | |

## Audit (#8) ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/audits` | ADMIN | `{ name, scopeDepartmentId?, scopeLocation?, startDate, endDate }`. Auto-generates audit items for in-scope assets. |
| POST | `/audits/:id/auditors` | ADMIN | `{ auditorIds: [] }`. |
| GET | `/audits` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | with result counts. |
| GET | `/audits/:id` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | |
| GET | `/audits/:id/items` | assigned auditor or ADMIN/ASSET_MANAGER | a department head who is **not** an assigned auditor → 403. |
| PATCH | `/audits/:id/items/:itemId` | assigned auditor or ADMIN/ASSET_MANAGER | `{ result: VERIFIED\|MISSING\|DAMAGED, notes? }`. Rejected if cycle CLOSED. |
| GET | `/audits/:id/discrepancies` | ADMIN, ASSET_MANAGER, DEPARTMENT_HEAD | MISSING + DAMAGED items. |
| POST | `/audits/:id/close` | ADMIN | locks cycle; MISSING → asset LOST, DAMAGED → condition DAMAGED. |

## Dashboard & Reports (#2, #9) ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/reports/dashboard` | any auth (scoped) | KPI cards: assetsAvailable, assetsAllocated, assetsUnderMaintenance, maintenanceToday, activeBookings, pendingTransfers, upcomingReturns, overdueReturns (+ `overdueList`, `upcomingReturnsList`). The allocation counters/lists only cover what the caller may see. |
| GET | `/reports/dashboard/employee/kpis` | any auth | the caller's own KPI counters. |
| GET | `/reports/dashboard/employee/activity` | any auth | the caller's own activity. |
| GET | `/reports/dashboard/employee/chart` | any auth | "my assets over time". |
| GET | `/reports/asset-activity` | ADMIN, ASSET_MANAGER | allocated vs available over the last 8 days. |
| GET | `/reports/asset-status` | ADMIN, ASSET_MANAGER | status distribution. |
| GET | `/reports/analytics` | ADMIN, ASSET_MANAGER | consolidated payload for the analytics page. |
| GET | `/reports/asset-utilization` | ADMIN, ASSET_MANAGER | most-used vs idle. |
| GET | `/reports/maintenance-frequency` | ADMIN, ASSET_MANAGER | by asset & category. |
| GET | `/reports/due-maintenance` | ADMIN, ASSET_MANAGER | assets due/aging. |
| GET | `/reports/department-allocation` | ADMIN, ASSET_MANAGER | per-department totals. |
| GET | `/reports/booking-heatmap` | ADMIN, ASSET_MANAGER | `{ dayOfWeek, hour, count }[]`. |
| GET | `/reports/export/assets.csv` | ADMIN, ASSET_MANAGER | returns `text/csv`; quotes are escaped and formula injection (`=`, `+`, `-`, `@`) is neutralised. |

## Notifications & Activity Log (#10) ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/notifications` | any auth | `{ items, unreadCount }`. `?unread=true` for unread only. |
| PATCH | `/notifications/:id/read` | any auth (own) | |
| POST | `/notifications/read-all` | any auth | |
| POST | `/notifications/ping` | ADMIN, ASSET_MANAGER | `{ allocationId }` — reminds the holder about an overdue return. |
| GET | `/activity` | ADMIN, ASSET_MANAGER | immutable audit log. filters `entityType`, `entityId`, `actorId`, `take`, `skip`. |

## Health ✅

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/api` | public | → `Hello World!` (service health). |

---

### Known trade-offs (documented, acceptable for the hackathon scope)

- Booking `effectiveStatus` is derived on read (no background job flips UPCOMING→ONGOING→COMPLETED in the DB).
- `GET /assets` is readable by every authenticated user — knowing that an asset exists is not sensitive, but the *ownership* data attached to allocations, bookings and maintenance requests is scoped.
- Sign-up creates an EMPLOYEE without e-mail verification; in production this endpoint should be closed or paired with a verification step.
- The JWT is stored in `localStorage` by the SPA, so it is readable by any script on the page. The token itself carries no privilege (every request re-reads the user), but an httpOnly cookie would be stronger.
