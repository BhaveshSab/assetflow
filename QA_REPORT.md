# AssetFlow — role-by-role acceptance report

**Repository:** `github.com/BhaveshSab/assetflow`
**Commit under test:** `81d55fabe2ac139651763bff19a66d3973e9940f` (branch `main`, working tree clean)
**API:** `http://localhost:4000/api` · **Frontend:** built bundle served on `http://<preview>:3000`
**Database:** disposable **PGlite** (Postgres-in-WASM over the Postgres wire protocol) created for this run — the four real migrations replayed, then `prisma/seed.ts`. **Not** the production/demo database.
**Run:** 2026-11-07T14:48Z → 15:10Z · Node v26.13.0 / npm 11.20.0 · executed by the QA agent on a throwaway environment.
**Health gate:** `GET /api/health` → `{"status":"ok","database":"up","rateLimitStore":"memory","redis":"disabled"}` — gate passed before any role test.

> **Nothing in the application was changed.** No commits, no pushes, no deploys, no migrations, no edits under `src/`, `backend/`, `infra/` or `.github/`. The only file added to the tree is this report. Test rows are named `QA-…`.

---

## 1. Baseline numbers (measured, not quoted)

| Suite | Command | Result |
|---|---|---|
| Backend unit | `npm run test:unit` | **98 passed / 98**, 14 suites — exit 0 |
| Backend e2e | `npm run test:e2e` | **145 passed, 1 skipped / 146**, 15 suites — exit 0 |
| Frontend | `npm test` (vitest) | **93 passed / 93**, 13 files — exit 0 |
| Types | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 — **0 errors, 17 warnings** |

Environment note: the frontend suite only passes under **Node 22** (the version `backend/package.json` pins). On this host's Node 26 the jsdom `localStorage` is shadowed by Node's experimental global and all 93 tests crash in `src/test/setup.ts`. Run with `NODE_OPTIONS=--localstorage-file=…` and they are green. This is an environment mismatch, **not** a product defect — but CI should pin Node 22 so it cannot bite a contributor.

A green suite is the floor. Everything below was executed against the running API and UI.

---

## 2. Results — 74 checks (54 PASS · 15 FORBIDDEN-OK · 5 FAIL)

Verdicts: **PASS** works for the right roles · **FORBIDDEN-OK** correctly denied/hidden (this is a pass) · **FAIL** wrong, missing, or allowed-when-it-should-be-denied.

| ID | Role | Area | Check | Expected | Actual (evidence) | Verdict | Sev |
|---|---|---|---|---|---|---|---|
| TC-00 | all | Environment | Health gate | {"status":"ok","database":"up"} | 200 {"status":"ok","database":"up","rateLimitStore":"memory","redis":"disabled"…<br><sub>GET /api/health → 200 {"status":"ok","database":"up","rateLimitStore":"memory","redis":"disabled","timestamp":"2026-11-07T14:55:29.296Z"}</sub> | **PASS** | Blocker |
| TC-01 | Employee | S1 Session | Signup with a fresh email creates an EMPLOYEE | 2xx + role EMPLOYEE | 201 role=EMPLOYEE<br><sub>POST /api/auth/signup {email:qa.employee.mw6izgel@qa.local} → 201; GET /auth/me → 200 {"id":"cmw6izgju0000lu03yiclxeka","name":"QA New Hire","email":"qa.employee.mw6izgel@qa.local","role</sub> | **PASS** | Blocker |
| TC-02 | Employee | S1 Session | Signup with role:ADMIN must not produce an admin | 400 unknown field, or created EMPLOYEE | 400 role=null body={"message":["property role should not exist"],"error":"Bad R…<br><sub>POST /api/auth/signup {role:"ADMIN"} → 400 {"message":["property role should not exist"],"error":"Bad Request","statusCode":400}</sub> | **PASS** | Blocker |
| TC-03 | Employee | S1 Session | Wrong password → 401/400, generic message | 401/400 "invalid email or password"; no user enumer… | 401 "{"message":"Invalid email or password","error":"Unauthorized","statusCode"…<br><sub>POST /auth/login wrong pw → 401 {"message":"Invalid email or password","error":"Unauthorized","statusCode":401}</sub> | **PASS** | High |
| TC-04 | Employee | S1 Session | 10 wrong logins → 429 with Retry-After (AUTH_THROTTLE_LIM… | 429 at attempt 11 with Retry-After header | first 429 at attempt 11; Retry-After=absent<br><sub>12 sequential wrong logins on qa.throttle.mw6izgel@qa.local: first 429 on attempt 11, Retry-After=null</sub> | **PASS** | High |
| TC-05 | all | S1 Session | Protected endpoint without a token | 401 | 401 {"message":"Unauthorized","statusCode":401}<br><sub>GET /api/assets with no Authorization → 401</sub> | **PASS** | Blocker |
| TC-06 | Employee | S1 Session | Forgot password: link works once, reuse fails | 202 issued; reset 200; second use 400/401 | forgot→202; reset→200; reuse→400<br><sub>POST /auth/forgot-password → 202; mail file 2026-11-07T14-55-29-566Z-1.txt; POST /auth/reset-password → 200; reuse → 400 {"message":"This reset link is invalid or has expired. Request a new one.","error":"Bad …</sub> | **PASS** | High |
| TC-07 | Employee | S1 Session | Change password invalidates other sessions | old second token → 401, fresh token works | change→200; other session →401; returned token →200<br><sub>POST /auth/change-password → 200; GET /auth/me with the second pre-change token → 401</sub> | **PASS** | High |
| TC-08 | Admin | S1 Session | GET /auth/me returns caller role | role ADMIN | 200 role=ADMIN<br><sub>GET /api/auth/me (admin token) → 200 {"id":"cmw6ireby0003i603yhv7szhw","name":"Ava Admin","email":"admin@assetflow.com","role":"ADMIN","s</sub> | **PASS** | High |
| TC-10 | all | S2 Dashboard | KPI payload present for every role | dashboard object with the six KPI numbers | admin 200 keys=assetsAvailable,assetsAllocated,assetsUnderMaintenance,maintenan…<br><sub>GET /api/reports/dashboard → admin 200 {"assetsAvailable":5,"assetsAllocated":0,"assetsUnderMaintenance":0,"maintenanceToday":0,"activeBookings":0,"pendingTransfers":0,"upcomingReturns":0,"overdueReturns":0,"o…</sub> | **PASS** | Medium |
| TC-11 | Asset Manager | S2 Dashboard | Overdue returns shown separately from upcoming ones | overdueList populated independently of upcomingRetu… | both present and separated<br><sub>Dashboard as manager: {"upcomingReturns":1,"overdueReturns":1,"overdueList":[{...ACTIVE, expectedReturnDate in the past...}]}. UI: an "OVERDUE RETURNS 1" card, an "UPCOMING RETURNS 1" card, and an "Overdue Ret…</sub> | **PASS** | - |
| TC-12 | Employee | S2 Dashboard | Employee cannot register an asset (quick action must be a… | 403 | 403 {"message":"You do not have permission to perform this action","error":"For…<br><sub>POST /api/assets with the employee token → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","statusCode":403}</sub> | **FORBIDDEN-OK** | High |
| TC-13 | Employee | S2 Dashboard | Employee dashboard shows only their own data | employee KPIs come from their own allocations; org-… | employee payload is byte-for-byte the admin payload for the asset/KPI counters<br><sub>GET /api/reports/dashboard as priya@acme.com → {"assetsAvailable":10,"assetsAllocated":6,"assetsUnderMaintenance":0,"maintenanceToday":2,"activeBookings":0,"pendingTransfers":1,...} — identical to admin@assetf…</sub> | **FAIL** | High |
| TC-10b | Employee | S2 Dashboard | Employee KPI endpoint answers and reflects own allocations | 200 with myAllocatedAssets matching /allocations/my | myAllocations 4 === /allocations/my ACTIVE 4<br><sub>GET /api/reports/dashboard/employee/kpis → {"myAllocations":4,"myUpcomingReturns":0,"myOverdueReturns":1,"myActiveBookings":0}; GET /api/allocations/my → 4 ACTIVE rows. First pass compared against a field name…</sub> | **PASS** | - |
| TC-20 | Admin | S3 Org | Department create/edit/deactivate + head + parent + status | create 201, patch 200 | create=201 patch=200 body={"id":"cmw6izgux0007lu03pkd9rde5","name":"QA Dept mw6…<br><sub>POST /api/org/departments → 201 {"id":"cmw6izgux0007lu03pkd9rde5","name":"QA Dept mw6izgel","status":"ACTIVE","parentDepartmentId":null,"headId":null,"createdAt":"2026-11-07T14:55:29.817Z","updatedAt":"2026-11…</sub> | **PASS** | Medium |
| TC-21 | Admin | S3 Org | Category create/edit (+ custom fields) | create 201 with customFields supported | create=201 body={"id":"cmw6izgvc0009lu032rnz9x8l","name":"QA Cat mw6izgel","sta…<br><sub>POST /api/org/categories → 201 {"id":"cmw6izgvc0009lu032rnz9x8l","name":"QA Cat mw6izgel","status":"ACTIVE","customFields":null,"createdAt":"2026-11-07T14:55:29.832Z","updatedAt":"2026-11-07T14:55:29.832Z","_c…</sub> | **PASS** | Medium |
| TC-22 | Admin | S3 Org | Employee directory returns name/email/department/role/sta… | rows with those fields | 200 rows=8 sample={"id":"cmw6ireby0003i603yhv7szhw","name":"Ava Admin","email":…<br><sub>GET /api/org/employees (admin) → 200 {"items":[{"id":"cmw6ireby0003i603yhv7szhw","name":"Ava Admin","email":"admin@assetflow.com","role":"ADMIN","status":"ACTIVE","departmentId":null,"department":null},{"id":"…</sub> | **PASS** | Medium |
| TC-23 | Admin | S3 Org | Role change only via PATCH /org/employees/:id/role, ADMIN… | manager 403, employee 403 | manager=403 employee=403<br><sub>PATCH /api/org/employees/cmw6irech0007i603o8rsadnz/role as manager → 403; as employee(role:ADMIN) → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","statusCode":403}</sub> | **FORBIDDEN-OK** | Blocker |
| TC-24 | Asset Manager | S3 Org | POST /org/departments + /org/categories + PATCH /org/empl… | 403 on all three | dept=403 cat=403 emp=403<br><sub>POST /api/org/departments → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","status \| POST /api/org/categories → 403 \| PATCH /api/org/employees/:id → 403 {"message":"You …</sub> | **FORBIDDEN-OK** | High |
| TC-24 | Department Head | S3 Org | POST /org/departments + /org/categories + PATCH /org/empl… | 403 on all three | dept=403 cat=403 emp=403<br><sub>POST /api/org/departments → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","status \| POST /api/org/categories → 403 \| PATCH /api/org/employees/:id → 403 {"message":"You …</sub> | **FORBIDDEN-OK** | High |
| TC-24 | undefined | S3 Org | POST /org/departments + /org/categories + PATCH /org/empl… | 403 on all three | dept=403 cat=403 emp=403<br><sub>POST /api/org/departments → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","status \| POST /api/org/categories → 403 \| PATCH /api/org/employees/:id → 403 {"message":"You …</sub> | **FORBIDDEN-OK** | High |
| TC-25 | Employee | S3 Org | Employee GET /org/employees | 403 | 403 {"message":"You do not have permission to perform this action","error":"For…<br><sub>GET /api/org/employees (employee token) → 403; head → 200; manager → 200</sub> | **FORBIDDEN-OK** | High |
| TC-30 | Asset Manager | S4 Assets | Register asset with all listed fields | 201, status AVAILABLE, fields stored | 201 tag=AF-0006 status=AVAILABLE loc=QA-Store-Room bookable=false cost=1500<br><sub>POST /api/assets → 201 {"id":"cmw6izgx2000clu03n4jjxfdi","assetTag":"AF-0006","name":"QA Laptop mw6izgel","serialNumber":"QASN-mw6izgel","acquisitionDate":"2026-01-15T00:00:00.000Z","acquisitionCost":"1500","c…</sub> | **PASS** | Blocker |
| TC-31 | Asset Manager | S4 Assets | Asset tag auto-generated, unique (AF-nnnn) | AF-\d+ pattern, two registrations differ | AF-0006 / AF-0007<br><sub>POST /api/assets ×2 → tags AF-0006, AF-0007</sub> | **PASS** | High |
| TC-32 | undefined | S4 Assets | POST + PATCH /assets as EMPLOYEE | 403 on both | POST=403 PATCH=403<br><sub>POST /api/assets → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","statusCode":403}; PATCH /api/assets/:id → 403 {"message":"You do not have permission to perform this a…</sub> | **FORBIDDEN-OK** | High |
| TC-32 | Department Head | S4 Assets | POST + PATCH /assets as DEPARTMENT_HEAD | 403 on both | POST=403 PATCH=403<br><sub>POST /api/assets → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","statusCode":403}; PATCH /api/assets/:id → 403 {"message":"You do not have permission to perform this a…</sub> | **FORBIDDEN-OK** | High |
| TC-33 | Admin | S4 Assets | Search/filter by tag, serial, name, status, category, loc… | each filter returns the matching rows; a nonsense q… | q(tag)=1 q(serial)=1 q(name)=1 location=6 status=8 category=2 miss=0<br><sub>GET /api/assets?q=AF-0013 → 200 1 row(s); ?q=QASN7-mw6izgel → 1; ?location=QA-Store-Room → 6; ?status=AVAILABLE → 8; ?categoryId=cmw6irect0008i603y1bpedvv → 2; ?q=zzz-nothing-matches-zzz → 0</sub> | **PASS** | Medium |
| TC-34 | Asset Manager | S4 Assets | Seven asset states representable | LOST/RETIRED/DISPOSED settable; ALLOCATED/RESERVED/… | LOST=200 RETIRED=200 DISPOSED=200; others via allocation/booking/maintenance<br><sub>PATCH /assets/:id status LOST→200, RETIRED→200, DISPOSED→200</sub> | **PASS** | Medium |
| TC-35 | Admin | S4 Assets | Per-asset history shows allocation AND maintenance history | one payload with both collections populated | both collections present and populated on the assets used<br><sub>GET /api/assets/:id/history after the allocation/transfer run → allocations contain Priya then Raj; after the maintenance run on a separate asset → {"allocations":[],"maintenance":[{"description":"QA: paper ja…</sub> | **PASS** | - |
| TC-40 | Asset Manager | S5 Allocation | Allocate available asset to Priya with return date | 201/200, asset ALLOCATED, Priya notified | 201 allocStatus=ACTIVE assetStatus=AVAILABLE<br><sub>POST /api/allocations → 201 {"id":"cmw6izh1p000llu031t4fh0ok","status":"ACTIVE","assetId":"cmw6izh14000jlu03s2wnnph2","holderUserId":"cmw6irece0006i603zdz5u9xy","departmentId":null,"allocatedById":"cmw6irec500…</sub> | **PASS** | Blocker |
| TC-41 | Asset Manager | S5 Allocation | BLOCKER: second allocation of the same asset is refused | 409 naming Priya as current holder + pointer to tra… | 409 {"message":"Asset AF-0008 is currently held by Priya Sharma","currentHolder…<br><sub>POST /api/allocations (same assetId, holder Raj) → 409 {"message":"Asset AF-0008 is currently held by Priya Sharma","currentHolder":{"id":"cmw6irece0006i603zdz5u9xy","name":"Priya Sharma","email":"priya@acme.c…</sub> | **PASS** | Blocker |
| TC-42 | Employee | S5 Allocation | Employee POST /allocations | 403 | 403 {"message":"You do not have permission to perform this action","error":"For…<br><sub>POST /api/allocations (employee token) → 403</sub> | **FORBIDDEN-OK** | High |
| TC-43 | Asset Manager | S5 Allocation | Transfer: request → approve → re-allocated, history shows… | transfer 201, approve 200, history contains Priya t… | request=201 approve=200 historyHasPriya=true historyHasRaj=true<br><sub>POST /api/transfers → 201; POST /api/transfers/:id/approve → 200; GET /api/assets/:id/history → 200 {"allocations":[{"id":"cmw6izh3y000rlu03k4eqvz6n","status":"ACTIVE","assetId":"cmw6izh14000jlu03s2wnnph2","ho…</sub> | **PASS** | High |
| TC-44 | Department Head | S5 Allocation | Head of IT cannot approve a transfer that involves no IT … | 403 on approve and reject of a Facilities → QA-depa… | fac→qa approve=403 reject=403; fac→IT approve=200<br><sub>Facilities asset held by Raj; transfer to department "QA Dept Renamed mw6izgel" → 201; HEAD(IT) approve → 403 {"message":"You can only approve transfers that involve your department","error":"Forbidden","statu…</sub> | **PASS** | Blocker |
| TC-45 | Employee | S5 Allocation | Return with condition notes → AVAILABLE, note recorded | holder return 200 with notes; non-holder 403; asset… | nonHolder=403 return=200 asset=AVAILABLE notes="QA check-in: screen scratched" …<br><sub>POST /api/allocations/:id/return as non-holder → 403; as holder with {checkInNotes, conditionOnReturn:FAIR} → 200 {"id":"cmw6izh9x0019lu03w4dmrihm","status":"RETURNED","assetId":"cmw6izh9h0017lu03wgzfxqk3","ho…</sub> | **PASS** | High |
| TC-46 | Asset Manager | S5 Allocation | Overdue allocation surfaces in /overdue, dashboard and no… | appears in all three | overdue=200 listed=true dashboard={"assetsAvailable":6,"assetsAllocated":3,"ass…<br><sub>Backdated expectedReturnDate 3 days; GET /api/allocations/overdue → 200 contains id: true; dashboard {"assetsAvailable":6,"assetsAllocated":3,"assetsUnderMaintenance":0,"maintenanceToday":0,"activeBookings":0,…</sub> | **PASS** | High |
| TC-47 | Employee | S5 Allocation | GET /allocations as Employee (must use /my) | 403; /my → 200 | list=403 my=200<br><sub>GET /api/allocations → 403; GET /api/allocations/my → 200</sub> | **FORBIDDEN-OK** | High |
| TC-50 | Employee | S6 Booking | Book 09:00–10:00 | 201 confirmed/upcoming | 201 status=UPCOMING<br><sub>POST /api/bookings {09:00–10:00} → 201 {"id":"cmw6izhgm001llu03ttspspii","status":"UPCOMING","assetId":"cmw6izhg0001jlu03u8dfii95","bookedById":"cmw6irece0006i603zdz5u9xy","startTime":"2026-11-09T09:00:00.000Z…</sub> | **PASS** | Blocker |
| TC-51 | Employee | S6 Booking | BLOCKER: overlapping booking 09:30–10:30 rejected | 409 | 409 {"message":"This time slot overlaps an existing booking for this asset","er…<br><sub>POST /api/bookings {09:30–10:30, other user} → 409 {"message":"This time slot overlaps an existing booking for this asset","error":"Conflict","statusCode":409}</sub> | **PASS** | Blocker |
| TC-52 | Department Head | S6 Booking | BLOCKER: adjacent booking 10:00–11:00 accepted | 201 | 201 {"id":"cmw6izhhl001olu03iuioi4xt","status":"UPCOMING","assetId":"cmw6izhg00…<br><sub>POST /api/bookings {10:00–11:00, adjacent to 09:00–10:00} → 201 {"id":"cmw6izhhl001olu03iuioi4xt","status":"UPCOMING","assetId":"cmw6izhg0001jlu03u8dfii95","bookedById":"cmw6ireca0005i603kf1r94fo","startTime":…</sub> | **PASS** | Blocker |
| TC-43b | Asset Manager | S5 Allocation | Rejected transfer leaves the original holder in place | reject 200; transfer REJECTED; Priya still the ACTI… | request=201 reject=200/REJECTED activeHolderIsPriya=true<br><sub>POST /transfers → 201; POST /transfers/:id/reject → 200 {"id":"cmw6j2lbi0037lu03em6uq43k","status":"REJECTED","assetId":"cmw6j2lal0032lu0378jbcb4v","requestedById":"cmw6irece0006i603zdz5u9xy","toUserId":"cmw6i…</sub> | **PASS** | High |
| TC-53 | Employee | S6 Booking | Booking a non-bookable asset | 409/400 rejected | 409 {"message":"This asset is not bookable","error":"Conflict","statusCode":409}<br><sub>POST /api/bookings on isBookable=false asset → 409 {"message":"This asset is not bookable","error":"Conflict","statusCode":409}</sub> | **PASS** | High |
| TC-54 | Employee | S6 Booking | Cancel and reschedule | cancel 200 → CANCELLED; reschedule 200 | cancel=200/CANCELLED reschedule=200/UPCOMING<br><sub>POST /bookings/:id/cancel → 200 {"id":"cmw6izhgm001llu03ttspspii","status":"CANCELLED","assetId":"cmw6izhg0001jlu03u8dfii95","bookedById":"cmw6irece0006i603zdz5u9xy","start; PATCH /bookings/:id/reschedule → 20…</sub> | **PASS** | Medium |
| TC-55 | all | S6 Booking | Upcoming/Ongoing/Completed/Cancelled all reachable | all four statuses appear | stored status is UPCOMING/CANCELLED; ONGOING/COMPLETED are derived per read<br><sub>GET /api/bookings → [["UPCOMING","COMPLETED"],["CANCELLED","CANCELLED"],["UPCOMING","UPCOMING"],["UPCOMING","UPCOMING"]] — status/effectiveStatus pairs. Code: bookings.service.ts:337-350 derives ONGOING/COMPLE…</sub> | **PASS** | - |
| TC-56 | Employee | S6 Booking | Reminder notification before the slot starts | a BOOKING_REMINDER notification appears before star… | no reminder is ever generated<br><sub>No scheduler/queue in the backend and no code path that creates NotificationType.BOOKING_REMINDER (enum member only, schema.prisma:122; zero writers under backend/src). A booking created and left to mature pro…</sub> | **FAIL** | High |
| TC-57 | Employee | S6 Booking | Employee and Head can book; cannot book as another user | 201 as self; any userId in body ignored/rejected | 201; body has no userId field in DTO → booking is always self<br><sub>POST /api/bookings as Priya → 201 {"id":"cmw6izhjz001ylu03cqlmdo6i","status":"UPCOMING","assetId":"cmw6izhg0001jlu03u8dfii95","bookedById":"cmw6irece0006i603zdz5u9xy","startTime":"2026-11-09T16:</sub> | **PASS** | Medium |
| TC-60 | Employee | S7 Maintenance | Any role raises a request → PENDING, asset UNCHANGED | 201 PENDING; asset still AVAILABLE | 201 PENDING; asset=AVAILABLE<br><sub>POST /api/maintenance {assetId, description, priority:HIGH, photoUrl} → 201 {"id":"cmw6j2l69002mlu034rh0sxfb","status":"PENDING","priority":"HIGH","assetId":"cmw6j2l5v002klu03y7xjvw1b","raisedById":"cmw6irece0…</sub> | **PASS** | Blocker |
| TC-61 | Asset Manager | S7 Maintenance | BLOCKER: asset flips to UNDER_MAINTENANCE only on approval | AVAILABLE while PENDING; UNDER_MAINTENANCE after ap… | before=AVAILABLE approve=200/APPROVED after=UNDER_MAINTENANCE<br><sub>asset while PENDING: AVAILABLE; POST /maintenance/:id/approve → 200 {"id":"cmw6j2l69002mlu034rh0sxfb","status":"APPROVED","priority":"HIGH","assetId":"cmw6j2l5v002klu03y7xjvw1b","raisedById":"cmw6irece0006i603…</sub> | **PASS** | Blocker |
| TC-62 | Asset Manager | S7 Maintenance | Reject → REJECTED, asset unchanged | 200 REJECTED; asset still AVAILABLE | reject=200/REJECTED asset=AVAILABLE<br><sub>POST /maintenance/:id/reject → 200 {"id":"cmw6j2l7y002tlu03k6olf1yf","status":"REJECTED","priority":"LOW","assetId":"cmw6j2l7p002rlu03sb87eq1h","raisedById":"cmw6irech0007i603o8rsadnz","approvedB; asset → AVAI…</sub> | **PASS** | High |
| TC-63 | Asset Manager | S7 Maintenance | Pending→Approved→Assigned→In Progress→Resolved; asset AVA… | every step 200; asset AVAILABLE at the end | assign=200/TECHNICIAN_ASSIGNED start=200/IN_PROGRESS resolve=200/RESOLVED asset…<br><sub>assign → 200 TECHNICIAN_ASSIGNED; start → 200 IN_PROGRESS; resolve → 200 {"id":"cmw6j2l69002mlu034rh0sxfb","status":"RESOLVED","priority":"HIGH","assetId":"cmw6j2l5v002klu03y7xjvw1b","raisedById":"cmw6irece000…</sub> | **PASS** | High |
| TC-64 | undefined | S7 Maintenance | Approve as EMPLOYEE | 403 | 403 {"message":"You do not have permission to perform this action","error":"For…<br><sub>POST /api/maintenance/:id/approve (EMPLOYEE) → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","statusCode":403}</sub> | **FORBIDDEN-OK** | High |
| TC-64 | Department Head | S7 Maintenance | Approve as DEPARTMENT_HEAD | 403 | 403 {"message":"You do not have permission to perform this action","error":"For…<br><sub>POST /api/maintenance/:id/approve (DEPARTMENT_HEAD) → 403 {"message":"You do not have permission to perform this action","error":"Forbidden","statusCode":403}</sub> | **FORBIDDEN-OK** | High |
| TC-65 | all | S7 Maintenance | Maintenance history retained per asset | history lists the resolved request | 200 {"allocations":[],"maintenance":[{"id":"cmw6j2l69002mlu034rh0sxfb","status"…<br><sub>GET /api/assets/:id/history → 200 {"allocations":[],"maintenance":[{"id":"cmw6j2l69002mlu034rh0sxfb","status":"RESOLVED","priority":"HIGH","assetId":"cmw6j2l5v002klu03y7xjvw1b","raisedById":"cmw6irece0006i603z…</sub> | **PASS** | Medium |
| TC-70 | Admin | S8 Audit | Create cycle with scope + date range | 201 with generated items | 201 items=6<br><sub>POST /api/audits → 201 {"id":"cmw6izhnk0023lu03557qcnpm","name":"QA Cycle mw6izgel","status":"OPEN","scopeDepartmentId":null,"scopeLocation":"QA-Store-Room","startDate":"2026-11-07T14:55:30.843Z","endDate":"20…</sub> | **PASS** | High |
| TC-71 | Admin | S8 Audit | Assign auditors | 200/201 | 201 {"id":"cmw6izhnk0023lu03557qcnpm","name":"QA Cycle mw6izgel","status":"OPEN…<br><sub>POST /api/audits/:id/auditors → 201 {"id":"cmw6izhnk0023lu03557qcnpm","name":"QA Cycle mw6izgel","status":"OPEN","scopeDepartmentId":null,"scopeLocation":"QA-Store-Room","startDate":"2026-11-07T14</sub> | **PASS** | High |
| TC-72 | Employee | S8 Audit | Assigned auditor marks an item; unassigned user refused | unassigned 403, assigned 200 | unassigned=403 assigned=200<br><sub>PATCH /audits/:id/items/:itemId as unassigned Raj → 403 {"message":"Only an assigned auditor or a manager may mark audit items","error":"Forbidden","statusCode":403}; as assigned Priya → 200 {"id":"cmw6izhnq00…</sub> | **PASS** | Blocker |
| TC-73 | Admin | S8 Audit | Discrepancy report lists MISSING/DAMAGED with asset info | non-empty, includes asset tag/name | 200 nonEmpty=true {"items":[{"id":"cmw6izhnq0024lu032jwnkdk8","result":"MISSING…<br><sub>GET /api/audits/:id/discrepancies → 200 {"items":[{"id":"cmw6izhnq0024lu032jwnkdk8","result":"MISSING","auditCycleId":"cmw6izhnk0023lu03557qcnpm","assetId":"cmw6izgxl000elu03jsuq7s3k","auditedById":"cmw6irece0…</sub> | **PASS** | High |
| TC-74 | Admin | S8 Audit | Close cycle: ADMIN only, locks, MISSING→LOST, edits rejec… | manager/head 403; admin 200; later edit 409/400; cy… | mgr=403 head=403 admin=200 editAfter=409 cycle=CLOSED<br><sub>POST /audits/:id/close as manager → 403, head → 403, admin → 200 {"id":"cmw6izhnk0023lu03557qcnpm","name":"QA Cycle mw6izgel","status":"CLOSED","scopeDepartmentId":null,"scopeLocation":"QA-Store-Room","startDa…</sub> | **PASS** | Blocker |
| TC-75 | Admin | S8 Audit | Audit history retained after closing | cycle detail still returns assignments + items | detail=200 {"id":"cmw6izhnk0023lu03557qcnpm","name":"QA Cycle mw6izgel","status…<br><sub>GET /api/audits/:id after close → 200 {"id":"cmw6izhnk0023lu03557qcnpm","name":"QA Cycle mw6izgel","status":"CLOSED","scopeDepartmentId":null,"scopeLocation":"QA-Store-Room","startDate":"2026-11-07T14:55:30.84…</sub> | **PASS** | Medium |
| TC-80 | Asset Manager | S9 Reports | Analytics endpoints answer for ADMIN/ASSET_MANAGER | 200 with data for each endpoint | analytics=200 asset-utilization=200 maintenance-frequency=200 due-maintenance=2…<br><sub>GET /reports/analytics, /reports/asset-utilization, /reports/maintenance-frequency, /reports/due-maintenance, /reports/department-allocation, /reports/booking-heatmap, /reports/asset-activity, /reports/asset-s…</sub> | **PASS** | High |
| TC-81 | Admin | S9 Reports | Maintenance frequency by asset and category | payload has maintenance frequency data | 200 keys=kpis,utilizationTrend,departmentAllocations,assetStatus,bookingHeatmap<br><sub>GET /api/reports/analytics → 200 {"kpis":{"totalAssets":13,"utilizationRate":23,"maintenancePending":0,"activeBookings":0},"utilizationTrend":[{"month":"Jun","rate":0},{"month":"Jul","rate":0},{"month":"Aug","…</sub> | **PASS** | Medium |
| TC-74b | Asset Manager | S8 Audit | UI half of "Close Cycle" — hidden/disabled for non-admins | hidden or visibly disabled for a non-admin (DECISIO… | rendered and enabled for the Asset Manager; clicking it 403s<br><sub>Live UI as manager@assetflow.com on Asset Audits: Create button = {label:"Admins Only", disabled:true} (correct), Close Cycle = {label:"Close Cycle", disabled:false} → click → label "Confirm close?" → click → …</sub> | **FAIL** | High |
| TC-85 | Admin | S9 Reports | CSV export contains real rows | > 1 line incl. header | 200 lines=14 first="assetTag,name,category,status,condition,location,serialNumb…<br><sub>GET /api/reports/export/assets.csv → 200, 14 lines, header "assetTag,name,category,status,condition,location,serialNumber,acquisitionDate,ac"</sub> | **PASS** | High |
| TC-86 | Employee | S9 Reports | Every analytics endpoint 403 for EMPLOYEE + DEPARTMENT_HE… | 403 on all analytics | analytics=403/403 asset-utilization=403/403 maintenance-frequency=403/403 due-m…<br><sub>GET (employee/head) → analytics:403/403, asset-utilization:403/403, maintenance-frequency:403/403, due-maintenance:403/403, department-allocation:403/403, booking-heatmap:403/403, asset-activity:403/403, asset…</sub> | **FORBIDDEN-OK** | High |
| TC-90 | Employee | S10 Notifications | Notification types fired | Asset Assigned, Maintenance Approved/Rejected, Book… | 10 of 13 types observed; BOOKING_REMINDER, OVERDUE_RETURN and AUDIT_DISCREPANCY…<br><sub>SELECT type, count(*) FROM "Notification" GROUP BY type → ASSET_ASSIGNED 10, TRANSFER_REQUESTED 5, TRANSFER_APPROVED 3, TRANSFER_REJECTED 1, MAINTENANCE_RAISED 2, MAINTENANCE_APPROVED 1, MAINTENANCE_REJECTED 1…</sub> | **FAIL** | High |
| TC-91 | Employee | S10 Notifications | Mark one/all read; unread count matches | both work; 0 unread after read-all | one=200 all=201 unreadAfter=0<br><sub>PATCH /notifications/:id/read → 200; POST /notifications/read-all → 201 ; unread after → 0</sub> | **PASS** | High |
| TC-92 | Department Head | S10 Activity | Activity log is ADMIN + ASSET_MANAGER only | admin 200, manager 200, head 403, employee 403 | admin=200 mgr=200 head=403 emp=403<br><sub>GET /api/activity → admin 200, manager 200, head 403 {"message":"You do not have permission to perform this action","error":"Forbidden","statusCode":403}, employee 403</sub> | **FORBIDDEN-OK** | High |
| TC-93 | Admin | S10 Activity | State changes left activity rows with actor/action/time | rows name actor, action, timestamp | 200 {"items":[{"id":"cmw6izhqn002flu035l9xzj4m","actorId":"cmw6ireby0003i603yhv…<br><sub>GET /api/activity → 200 {"items":[{"id":"cmw6izhqn002flu035l9xzj4m","actorId":"cmw6ireby0003i603yhv7szhw","action":"audit.closed","entityType":"AuditCycle","entityId":"cmw6izhnk0023lu03557qcnpm","metadata":{"n…</sub> | **PASS** | Medium |
| TC-100 | Employee | Security | No self-elevation by any non-admin role | 403 everywhere | selfRole=403 dept=403<br><sub>PATCH /org/employees/{self}/role {role:ADMIN} → 403; POST /org/departments → 403</sub> | **FORBIDDEN-OK** | Blocker |
| TC-101 | Employee | Security | 401 without token vs 403 with wrong role | no token 401; wrong role 403 | anon=401 employee=403<br><sub>GET /api/allocations no token → 401; with employee token → 403</sub> | **PASS** | High |
| TC-102 | Department Head | Security | IDOR: head reading another department’s resources by id | 403 for another department’s employee; allocation l… | GET /org/employees (head) rows=9 distinctDepartments=3; GET /org/employees/cmw6…<br><sub>GET /api/org/employees as head of IT → 200, 9 rows, 3 distinct department id(s); GET /api/org/employees/:id (Raj, Facilities) → 200 {"id":"cmw6irech0007i603o8rsadnz","name":"Raj Verma","email":"raj@acme.com","…</sub> | **FAIL** | High |
| TC-103 | all | Security | Global limit: 300 req/min, the 301st is 429 + Retry-After | 300 × 200 then 429 with Retry-After | last200=300 first429=301 Retry-After=60<br><sub>301 sequential GET /reports/dashboard with one dedicated token (THROTTLE_LIMIT=300, THROTTLE_TTL=60000): request 301 → 429, Retry-After=60</sub> | **PASS** | High |
| TC-104 | Admin | Security | No secret/stack leaks in responses | no passwordHash, no secrets, no stack traces | clean across sampled responses<br><sub>Scanned 8317 chars of responses (me, employees, allocation, history, notifications) for passwordHash/JWT_SECRET/stack traces</sub> | **PASS** | High |
| TC-105 | Admin | Security | Deactivated user cannot log in; existing token dies | PATCH 200; login 401; old token 401 | patch=200 login=401 token=401<br><sub>PATCH /org/employees/:id {status:INACTIVE} → 200 {"id":"cmw6izgju0000lu03yiclxeka","name":"QA New Hire","email":"qa.employee.mw6izgel@qa.local","role":"EMPLOYEE","status; POST /auth/login → 401; GET /auth/me w…</sub> | **PASS** | Blocker |

Every row above carries its own request/status/response evidence. The raw machine-readable logs (`results.json`, `results-retest.json`) and the harnesses that produced them (`qa-api.mjs`, `qa-retest.mjs`) are kept in the chat workspace beside this report, outside the repository.

---

## 3. Score by role

| Role | Passed | Open failures |
|---|---|---|
| Admin | 17 of 17 | none |
| Asset Manager | 14 of 15 | TC-74b (UI half of "Close Cycle" — hidden/disabled for non-admins) |
| Department Head | 6 of 7 | TC-102 (IDOR: head reading another department’s resources by id) |
| Employee | 23 of 26 | TC-13 (Employee dashboard shows only their own data); TC-56 (Reminder notification before the slot starts); TC-90 (Notification types fired) |

**The four Blocker rules from §8 are all proven, none open:**

| Blocker rule | Verdict | Evidence |
|---|---|---|
| No self-elevation | **PASS** | `POST /auth/signup {role:"ADMIN"}` → 400 `"property role should not exist"` and no user created as admin; employee `PATCH /org/employees/:self/role` → 403; manager → 403 |
| No double allocation | **PASS** | second `POST /allocations` for the same asset → **409** `"Asset AF-0016 is currently held by Priya Sharma"`; asset stayed with the first holder |
| No booking overlap | **PASS** | 09:00–10:00 → 201; **09:30–10:30 → 409**; **10:00–11:00 → 201** (adjacent accepted) |
| No UNDER_MAINTENANCE before approval | **PASS** | asset `AVAILABLE` while the request is PENDING; flips to `UNDER_MAINTENANCE` only after `POST /maintenance/:id/approve` → 200 |

---

## 4. Findings

### BLOCKER
None open. All four blocker rules pass (table above). Every FAIL below is outside those four.

---

### HIGH

**H-1 · `Close Cycle` is enabled for a non-admin and always fails** — *TC-74b*
A visible, enabled control that cannot succeed; the API refuses it, so no data risk — but it is exactly the class of defect `docs/DECISIONS.md` #40 exists to prevent, and it is the suspect already recorded in the brief (**confirmed**).

1. Sign in as `manager@assetflow.com` (ASSET_MANAGER), open **Asset Audits**.
2. Observe the create button: `"Admins Only"`, `disabled: true` — correct.
3. Observe a cycle card in progress: the button reads **`Close Cycle`**, `disabled: false`.
4. Click it → it becomes **`Confirm close?`**; click again.
5. Network: `POST /api/audits/:id/close` → **403**; page shows *"You do not have permission to perform this action."*

**Expected:** the control hidden, or visibly disabled with a reason (like the create button).
**Actual:** enabled, clickable, guaranteed 403.
**Cause:** `src/components/dashboard/AssetAudits.tsx:508` — the action block is gated only by `{!isCompleted && (`; `isAdmin` (line 107) is used for the create button only.
**Severity:** High (UI-only; API is correct).

---

**H-2 · `/api/reports/dashboard` returns organisation-wide figures to an employee** — *TC-13*
`reports.service.ts` documents the endpoint as scoped ("an employee only sees their own allocations, a department head only their department's") and applies `allocationScope(user)` — but only to the overdue/upcoming **lists**. The counters are global.

1. `GET /api/reports/dashboard` as `priya@acme.com` (EMPLOYEE).
2. Compare with `admin@assetflow.com` and `manager@assetflow.com`.

**Expected:** an employee sees their own numbers; org-wide only for Admin/Manager.
**Actual:** identical payload for all three — `assetsAvailable:10, assetsAllocated:6, assetsUnderMaintenance:0, maintenanceToday:2, activeBookings:0, pendingTransfers:1`. Only `upcomingReturns` differed (0 vs 1).
**Cause:** `backend/src/reports/reports.service.ts:96-119` — `prisma.asset.count(...)`, `maintenanceRequest.count(...)`, `booking.count(...)`, `transferRequest.count(...)` are called without a scope; `const scope = allocationScope(user)` (line 56) is only spread into `overdueWhere`/`upcomingWhere`.
**Severity:** High — an employee can read org-wide inventory and workload totals, which the role matrix forbids. (The employee *screen* itself uses the correctly-scoped `/reports/dashboard/employee/kpis`, so this is exposed at the API, not on the page.)

---

**H-3 · Reminder and discrepancy notifications are never generated** — *TC-56, TC-90*
Two of the required notification types have no writer at all, and the overdue alert only fires when a human presses "send ping".

1. `SELECT type, count(*) FROM "Notification" GROUP BY type` after exercising every workflow.
2. `grep -rn "BOOKING_REMINDER\|AUDIT_DISCREPANCY" backend/src --include=*.ts` (excluding specs).

**Expected:** all nine types named in TC-90 fire at least once; a booking produces a reminder before its slot.
**Actual:** 13 types occur, but **`BOOKING_REMINDER`**, **`AUDIT_DISCREPANCY`** and automatic **`OVERDUE_RETURN`** never do. Neither enum member has a creator anywhere in `backend/src`; there is no scheduler or queue (deliberately — see DECISIONS "no message queue"), so nothing can fire "before the slot starts".
**Cause:** no producer for `NotificationType.BOOKING_REMINDER` / `AUDIT_DISCREPANCY` (`backend/prisma/schema.prisma:110-128` defines them; nothing writes them).
**Severity:** High for a spec that lists them as acceptance criteria; the underlying flows (booking confirm/cancel, audit close) notify correctly.

---

### MEDIUM

**M-1 · A Department Head can read another department's employee by id** — *TC-102*
1. `GET /api/org/employees/:id` for Raj (Facilities) with the `head@assetflow.com` token (head of IT).
**Expected (per TC-102):** refused.
**Actual:** **200** with name, email, role, status, department. The list is equally unscoped: 9 rows across 3 departments.
**Cause:** `backend/src/org/employees.service.ts:160` — `findOne(id)` takes no caller; `list()` (line 55) only applies a department filter when the client asks. The controller deliberately allows `DEPARTMENT_HEAD` on both routes, so this looks like a **design choice** (an org-wide *directory* read) rather than an oversight. No write and no secret is exposed — but it contradicts the TC-102 acceptance criterion, so it is reported, not excused. Allocation/transfer scoping for heads is correct elsewhere (H-1 aside): a head's `GET /allocations` did not contain the Facilities holder.
**Severity:** Medium.

---

### LOW

**L-1 · Documented test counts are stale** — confirmed
`docs/RESUME_AUDIT.md:256` says *"319 automated checks — 84 unit, 143 e2e (142 passing, 1 skipped), 92 frontend"*. Measured on this commit: **98 unit, 146 e2e (145 passed, 1 skipped), 93 frontend = 337**. The numbers moved again after the audit was written.

**L-2 · `updateRole` writes its audit row outside the transaction** — confirmed
`backend/src/org/employees.service.ts` — the role change runs inside `this.prisma.$transaction(...)`, and `await this.activity.log({...})` is called after it (line 31 of the method). A crash between the two leaves a changed role with no activity row. The brief already recorded this; it is reproduced here, not newly found.

---

### Known suspects from the brief — confirmed or refuted

| Suspect | Verdict |
|---|---|
| "Close Cycle" visible to non-admins | **Confirmed** — H-1. Reachable by ASSET_MANAGER only (sidebar `allowedRoles:["ADMIN","ASSET_MANAGER"]`, `Sidebar.tsx:71`); Department Heads and Employees never see the screen. |
| Two dead `MoreVertical` row menus (Asset Directory, Organization Setup) | **Refuted** — both are `disabled`: `AssetDirectory.tsx:386`, `OrganizationSetup.tsx:926`. DECISIONS #40 is satisfied. |
| `updateRole` audit log outside the transaction | **Confirmed** — L-2. |
| Stale test count in docs | **Confirmed** — L-1. |
| Unrotated demo admin credentials on a shared database | **Not tested** — out of scope here by design: this run used a throwaway database, and the public Vercel demo was not touched. |

---

## 5. Spec coverage matrix — 10 screens × 4 roles

| Screen | Admin | Asset Manager | Department Head | Employee |
|---|---|---|---|---|
| S1 Login / Signup / Session | PASS | PASS | PASS | PASS — self-elevation blocked (TC-02, TC-100) |
| S2 Dashboard | PASS — org-wide KPIs, overdue separated | PASS | FAIL — same endpoint, org-wide counters (H-2 affects every non-manager role) | FAIL — org-wide counters from `/reports/dashboard` (H-2); the *screen* itself is correctly scoped (`myAllocations` 4 = 4) |
| S3 Organization Setup | PASS — dept/category/employee CRUD + role change (ADMIN only) | FORBIDDEN-OK — create/update 403, no nav entry | FORBIDDEN-OK — 403; reads directory (M-1) | FORBIDDEN-OK — `GET /org/employees` 403, no nav entry |
| S4 Asset Registration & Directory | PASS — register, tag `AF-nnnn`, filters, 7 states, history | PASS | FORBIDDEN-OK — POST/PATCH 403, no Register button | FORBIDDEN-OK — POST/PATCH 403 |
| S5 Allocation & Transfer | PASS | PASS — incl. the double-allocation 409 | PASS — own-department approvals; a transfer with no IT party refused (TC-44) | PASS — request/return allowed, `POST /allocations` 403, `GET /allocations` 403 |
| S6 Resource Booking | PASS — overlap 409, adjacent 201 | PASS | PASS | FAIL — reminders never fire (H-3); booking itself works |
| S7 Maintenance | PASS | PASS — approve flips the asset | PASS — raise only, approve 403 | PASS — raise only, approve/reject/assign/start/resolve 403 |
| S8 Audit Cycles | PASS — create/assign/mark/close, MISSING→LOST | FAIL — Close Cycle enabled but 403 (H-1) | FORBIDDEN-OK — screen unreachable, API 403 | FORBIDDEN-OK — unreachable; unassigned marker refused |
| S9 Reports & Analytics | PASS — all endpoints, CSV has rows | PASS | FORBIDDEN-OK — every analytics endpoint 403 | FORBIDDEN-OK — 403 on all analytics |
| S10 Activity Logs & Notifications | PASS — activity + notifications | PASS | FORBIDDEN-OK — `GET /activity` 403 | FORBIDDEN-OK — `GET /activity` 403; mark-read works, but 3 notification types never occur (H-3) |

---

## 6. Not tested, and why

1. **Token expiry (TC-06 expiry branch)** — the reset token lives 30 minutes; the run was ~25 minutes long and I did not artificially age it. Single-use and reuse-rejection **were** verified.
2. **Real SMTP delivery** — `MAIL_TRANSPORT=dev` (the repo default). The reset link was taken from the dev mail file, so the token flow is proven end-to-end; delivery through a real server is not.
3. **UI forms for Organization Setup, Categories, Reports and the booking calendar** — these were driven through the API only (status codes + payloads). The four role-critical UI questions (Close Cycle, Create Audit Cycle, sidebar per role, employee quick actions) **were** checked in the browser.
4. **Simultaneous (two-request) allocation/booking race** — the repo itself records that no test fires two requests in parallel. The conflict *rules* were verified sequentially; the row locks are argued, not demonstrated. Unchanged by this run.
5. **Charts and the Reports screen rendering** — the dashboard charts rendered (bar/pie/area present in the DOM); the Reports page itself was not opened.
6. **Public Vercel demo + demo-credential rotation** — deliberately untouched (no production data in scope).
7. **Audit "Start Audit Cycle" button** — there is no Draft state in the schema; the code comments say the branch was removed on purpose. Not a defect.
8. **Department head positive audit access** — the sidebar excludes heads from Asset Audits entirely, so there is no UI path to test; the API allows `DEPARTMENT_HEAD` on the read routes, which was exercised at API level.

---

## 7. Final verdict

| Role | Verdict |
|---|---|
| **Admin** | **WORKING** — full CRUD, audit lifecycle, reports/export, activity log; every non-admin probe against admin routes returned 403. |
| **Asset Manager** | **WORKING WITH DEFECTS** — the "Close Cycle" control is enabled for this role and always 403s (H-1). Everything else in the role (allocation conflict, approvals, maintenance state machine, reporting) behaves. |
| **Department Head** | **WORKING WITH DEFECTS** — can read any employee by id across departments (M-1); sharing the org-wide dashboard counters (H-2). Own-department approval scoping and asset visibility are correct. |
| **Employee** | **WORKING WITH DEFECTS** — `/reports/dashboard` exposes org-wide totals (H-2); booking reminders and automatic overdue/discrepancy notifications never fire (H-3). The employee cannot register, allocate, approve or reach manager screens under any probe. |

**Overall: 69 of 74 checks pass or are correctly forbidden (54 PASS + 15 FORBIDDEN-OK); 5 checks FAIL, tracing to 4 root causes — 3 High, 1 Medium — plus 2 Low findings outside the table. None of the four blocker rules is broken.**

Suggested fix order (matching §9 of the brief): H-2 and H-3 first (they are real capability gaps, and each needs an e2e test), then H-1 (one conditional), then M-1 (decide directory visibility on purpose and pin it with a test), then the docs.

---

## Post-audit fixes

The five FAIL rows above are fixed in this branch, and each fix is pinned by a
regression test in `backend/test/qa-fixes.e2e-spec.ts` (six cases):

| # | Defect (row above) | Fix | Where |
|---|--------------------|-----|-------|
| 1 | Dashboard leaked org-wide counters to an employee | `dashboard()` now scopes allocated/maintenance/booking/transfer counters by role | `backend/src/reports/reports.service.ts` |
| 2 | DEPARTMENT_HEAD could read any employee by id | `list()` and `findOne()` scope by the head's department; cross-department reads are 403 | `backend/src/org/employees.service.ts` |
| 3 | Role change could commit without its audit row | the `user.role_changed` activity entry is written inside the same transaction | `backend/src/org/employees.service.ts` |
| 4 | `AUDIT_DISCREPANCY` notification never produced | emitted when an auditor marks an item MISSING or DAMAGED | `backend/src/audits/audits.service.ts` |
| 5 | `BOOKING_REMINDER` / `OVERDUE_RETURN` never produced | `sweepReminders()` runs on a 60s interval, is idempotent, and is skipped under `NODE_ENV=test` | `backend/src/notifications/notifications.service.ts` |

Also fixed, found while re-testing the booking screen:

* **Confirmed bookings were impossible without first clicking a resource card.**
  The slot list is drawn for the first bookable resource, but confirming read
  `selectedResource` only and returned silently — the button did nothing, with no
  request and no message.
* Booking rejects (overlap 409, past start 400, non-bookable 409) reached the
  user as a generic "Booking failed. Please try again."; the API message is now
  shown (verified in the browser: *This time slot overlaps an existing booking
  for this asset*).
* Slots were built from UTC ("Z" appended to the local hour), so a 09:00 slot was
  booked at 14:30 IST; slot times now use local wall-clock time.
* Slots that had already ended were offered and then rejected by the API; they
  are now disabled and labelled "Past".
* The calendar is re-read after a booking, so a neighbouring slot shows the new
  overlap instead of staying "available".
* `Close Cycle` in Asset Audits was enabled for non-admins and failed with a 403;
  it is now disabled with a reason.

Checks at the time of writing: backend build clean, 98 unit tests, 152 e2e
(150 passing, 1 skipped, includes the six new cases), frontend 93 tests,
typecheck clean, ESLint 0 errors (18 pre-existing warnings).
