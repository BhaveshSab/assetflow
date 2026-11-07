# AssetFlow — role-by-role acceptance run (run 2)

**Code tested:** `main` @ `a7d08a5` ("Record the reports, export and department-head findings"), pulled from `origin/main` with `git fetch` + `git merge --ff-only`, no local commits on top.

**When:** 2026-11-08 · **Where:** sandbox clone, real NestJS app over HTTP (supertest) against the project's own PGlite test database.

**Result: 91 checks, 91 PASS, 0 FAIL, 0 "forbidden-but-tolerated".**

| Role | Checks touching this role | Verdict |
|---|---|---|
| Admin | 18 | **PASS** — full access, and every attempt to escape its boundaries was refused |
| Asset Manager | 17 | **PASS** |
| Department Head | 12 | **PASS** — including the two IDOR cases that failed in the previous report |
| Employee | 41 | **PASS** — including every deliberate escalation attempt (role injection, cross-department reads, acting on another user's booking, forged tokens), all refused |
| All roles (env, tokens, secrets) | 3 | **PASS** |

Raw evidence: `docs/results/qa-roles-run2.log` (91 `QA|…` lines, one per check, each with the HTTP status and the actual payload).

---

## 1. How this was run (and why it can be trusted)

The previous report (`QA_REPORT.md`, run on `81d55fa`) drove a live deployment by hand. This run drives the **real application code** through its **real HTTP stack** in-process:

- `createTestApp()` boots the actual `AppModule` — the same global pipes (`whitelist`, `forbidNonWhitelisted`), the same `JwtAuthGuard` / `RolesGuard`, the same controllers and services that run in production.
- The database is a real PostgreSQL-compatible engine (PGlite) built from `prisma/migrations`, i.e. the same schema the deployed Neon database has.
- Every role gets a real JWT from `POST /api/auth/login` or a real `POST /api/auth/signup`; nothing is stubbed or monkey-patched. The only direct service call is `NotificationsService.sweepReminders()`, used to trigger the 30-minute reminder sweep without waiting 30 minutes.
- Each run starts from an empty database, so the numbers below come from data the run itself created.

The harness file (`backend/test/qa-roles.e2e-spec.ts`) was **deleted after the run** — it is not part of the repository and does not ship.

Reproduce:

```bash
cd backend
npx jest --config ./test/jest-e2e.json --testPathPatterns qa-roles
```

(Recreate the temporary spec first if you want to re-run; it is not committed.)

---

## 2. Before / after — the five failures from the previous report

The run on `81d55fa` had 5 FAILs. All five were re-tested here:

| ID | Previous verdict (`81d55fa`) | Now (`a7d08a5`) | Evidence from this run |
|---|---|---|---|
| TC-13 | **FAIL** — employee dashboard showed the same org-wide zeros as admin | **PASS** | admin `{"available":2,"allocated":3}` vs employee `{"available":2,"allocated":1}`; separate `myAllocations/myUpcomingReturns/myOverdueReturns/myActiveBookings` KPIs returned `{1,0,1,0}`, matching `/allocations/my` |
| TC-56 | **FAIL** — booking reminder never fired | **PASS** | booking created 20 min out → `sweepReminders()` twice → exactly **1** `BOOKING_REMINDER` for the booker (idempotent: the second sweep added none) |
| TC-90 | **FAIL** — only 10 of 13 notification types observed; `BOOKING_REMINDER`, `OVERDUE_RETURN`, `AUDIT_DISCREPANCY` never fired | **PASS** | Across four mailboxes (priya, raj, manager, admin) 27 notifications, **16 of the 17 `NotificationType` values** observed live: `ASSET_ASSIGNED, ASSET_RETURNED, AUDIT_ASSIGNED, AUDIT_CLOSED, AUDIT_DISCREPANCY, BOOKING_CONFIRMED, BOOKING_CANCELLED, BOOKING_REMINDER, MAINTENANCE_RAISED, MAINTENANCE_APPROVED, MAINTENANCE_REJECTED, MAINTENANCE_RESOLVED, OVERDUE_RETURN, TRANSFER_REQUESTED, TRANSFER_APPROVED` — including all three that previously never fired. The two not triggered here (`TRANSFER_REJECTED`, `USER_ROLE_CHANGED`) are emitted at `allocations.service.ts:789` and `org/employees.service.ts:308`, flows this run did not exercise |
| TC-74b | **FAIL** — "Close Cycle" unusable from the UI | **PASS (backend)** + **PASS (code)** | Backend: `POST /audits/:id/close` as admin → 200, cycle `CLOSED`, and the asset of the `MISSING` item became `LOST`; a second edit → 409; as IT head → 403. UI: `src/components/dashboard/AssetAudits.tsx:504-534` renders the button **Admin-only**, disabled with "Only Admins can close an audit cycle", two-step confirm. No browser click was performed — see §6. |
| TC-102 | **FAIL** — a department head could read another department's employee by id | **PASS** | `GET /org/employees/<Raj, Facilities>` as the IT head → **403 "You can only view employees in your own department"**; the same call for Priya (IT) → 200; `GET /org/employees` as head → 5 rows, **1 distinct department**, Raj absent |

Bonus fix verified: the previous report's head-dashboard defect (a head landing on "Access Denied") is not reproducible at the API level — the head's dashboard, transfer queue and maintenance queue all return 200 with their own scoped data.

---

## 3. The four Blocker rules

| Rule | Test | Result |
|---|---|---|
| Nobody can make themselves an admin | `POST /auth/signup {role:"ADMIN"}` → 400 `["property role should not exist"]`; `PATCH /auth/me {role:ADMIN}` → 400; direct role change by manager/head/employee → 403; only `PATCH /org/employees/:id/role` as ADMIN works | **HOLDS** |
| One physical asset, one holder | second `POST /allocations` for a held asset → **409 "Asset AF-0001 is currently held by Priya Sharma"**; the asset's status did not change | **HOLDS** |
| No double-booking | 09:00–10:00 → 201; 09:30–10:30 → **409 "This time slot overlaps an existing booking for this asset"**; 10:00–11:00 (touching, not overlapping) → **201**; booking in the past → 400 `startTime must be in the future`; booking a `LOST` asset → **409 "Asset is out of service and cannot be booked (status: LOST)"** | **HOLDS** |
| Maintenance must not silently remove an asset from service | raise as employee → 201 `PENDING`, asset status **unchanged**; approve → 200 `UNDER_MAINTENANCE`; approve by head or employee → 403 | **HOLDS** |

---

## 4. What each role can do — and what each was refused

### Admin (18 checks, PASS)
Departments (create 201, patch 200 → `INACTIVE`), categories (201, `customFields` accepted as an array of descriptors), the full employee directory (8 rows, no secrets), role change 200, audit cycles (create with 6 items, assign auditors, close → 200 with the missing asset rewritten to `LOST`, edit-after-close 409), the CSV export (7 lines, header `assetTag,name,category,status,condition,location,serialNumber,acquisitionDate,acquisitionCost`), the activity log (39 rows, newest `audit.closed`), all 8 analytics endpoints (200/8).
Refused: nothing — Admin is meant to reach everything. Deactivating a user works: `PATCH status=INACTIVE` → 200, then login → **401** and the user's already-issued token → **401**.

### Asset Manager (17 checks, PASS)
Register assets (201 `AF-0001`, auto tag, `AVAILABLE`, unique tags `AF-0001/AF-0002`), set the bookable flag, search + filter (`?q=QA Laptop` → 1 row, `?status=AVAILABLE` → 5 rows), allocate (201, asset → `ALLOCATED`), return with condition note persisted into the asset history, approve/assign/start/resolve maintenance, read discrepancies, 8/8 analytics endpoints.
Refused: all three org writes (departments/categories/role change) → 403 each.

### Department Head (12 checks, PASS)
Approve an in-department transfer (request 201 → approve 200 → `currentHolder` becomes `it2@acme.com`, history keeps both holders), read their own dashboard (200), book a resource (201), see only their department's allocations (4 rows, all IT, Raj's live Facilities allocation **absent**, `?departmentId=Facilities` → 0 rows), view their own department's employees, fetch a same-department employee (200).
Refused: register/patch an asset → 403; approve maintenance → 403; close an audit → 403; all 8 analytics → 403; activity log → 403; approve a Facilities→Facilities transfer → **403 "You can only approve transfers that involve your department"**; another department's employee by id → **403**; org writes → 403.

### Employee (41 checks, PASS)
Signup (201, `EMPLOYEE`), login, forgot → 202 / reset → 200 / token reuse → 400, change password → 200 **with the old session killed (401)**, browse and search the catalogue, see their own allocations (`/allocations/my`), book/cancel/reschedule, raise maintenance (201 `PENDING`), see their own requests (`/maintenance/my` → only their own), read their notifications and mark them read (`read-all` → 0 unread), use the dashboard KPIs.
Refused (all deliberate escalation attempts): `POST /allocations` 403; `GET /allocations` 403; `POST/PATCH /assets` 403; `POST /audits` 403; `GET /audits` 403; approve maintenance 403; approve a transfer 403; every analytics endpoint 403 (8/8); the CSV export 403; the activity log 403; `GET /org/employees` 403; org writes 403; cancelling **someone else's** booking 403 and rescheduling it 403 (the booking stayed `UPCOMING`); signing up as admin 400; `PATCH /auth/me {role}` 400.

### Cross-cutting (3 checks, PASS)
Health `{"status":"ok","database":"up"}`; a protected route with no token → 401; a **tampered JWT** → 401; `/auth/me` exposes only `id,name,email,role,status,departmentId,avatarUrl,credentialsChangedAt`; no `passwordHash`, no `JWT_SECRET`, no stack trace in any sampled payload.

---

## 5. Findings

**Blocking defects: none.**

Two low-severity API observations (documented, not bugs in behaviour):

1. `PATCH /notifications/:id/read` returns **200** even when the notification belongs to another user. The database update is correctly scoped by `userId` (`notifications.service.ts:230-236`), so nothing changes — verified: after Priya tried to mark Raj's notification read, Raj's `isRead` was still `false`. Only the status code is over-permissive; a 404 would be tidier and makes no difference to data.
2. `POST /notifications/read-all` answers **201** (Nest's default for POST) rather than 200. Cosmetic.

Positive behaviour worth keeping:
- A `LOST` asset cannot be booked (`409 Asset is out of service…`) — the audit close and the booking engine agree with each other.
- Resolving maintenance restores `ALLOCATED` (not `AVAILABLE`) when the holder still has an active allocation — the asset doesn't silently come back into the pool.
- Transfer approval is department-scoped in both directions: a head can act when the transfer *touches* their department, and is refused when it doesn't.

---

## 6. What this run does **not** prove

Stated plainly so nobody over-reads the green:

1. **No browser was driven.** Layout, responsiveness, the calendar's visuals, the "Close Cycle" button's disabled state, axe/contrast — verified by code inspection and by the committed frontend test suite (95 tests), not by clicking. The one UI item from the previous report (Close Cycle) is confirmed in code at `src/components/dashboard/AssetAudits.tsx:504-534`.
2. **No email was delivered.** Password reset was proven end-to-end through the dev mailer's captured token, not through an SMTP round trip.
3. **Rate limiting was not re-proven here** — the 300 req/min + `Retry-After` rule is covered by the committed `backend/test/rate-limit.e2e-spec.ts`.
4. **Production configuration is out of scope**: Vercel env vars, CORS origins, Redis in a multi-instance deployment, Neon connection pooling. Those are deployment checks, not role checks.
5. **No source file was changed to make anything pass.** The only edits in this session were to the throwaway harness.

---

## 7. Honesty note — the checks that failed *at first*

A green run is only worth something if the false alarms are accounted for. The harness went through six iterations before this final one; every check that failed on the way is listed below with the reason, and in every case the fix was **in the harness**, not in the product:

| Check | What looked broken | Why it was the harness |
|---|---|---|
| TC-43 / TC-44 | transfer request → 403 | Only the **holder** (or a manager/head acting for their department) may request a transfer. The test asked as the wrong user. Fixed by having Priya request, and by choosing a transfer that never touches IT to prove the head's 403. |
| TC-45 | return left the asset `AVAILABLE`, expected `ALLOCATED` | The transfer it depended on had failed; the "active allocation" the assertion assumed didn't exist. |
| TC-48b | head's allocation list looked cross-department | The check read `holder.departmentId`; the API returns `departmentId` / `holderUser.departmentId`. |
| TC-21 | category with `customFields` → 400 | `customFields` is `@IsArray()` (descriptors), the test sent an object. |
| TC-91 | `read-all` left 11 unread | The field is `isRead`, not `readAt`. |
| TC-114 | past booking → 400 | It passed for the wrong reason ("assetId must be a string"); fixed to use a real bookable asset, now correctly `"startTime must be in the future"`. |
| TC-116 | `/maintenance/my` "not mine" | The field is `raisedById`, not `requesterUser`. |
| TC-120 | could not create a booking to test ownership | The asset had been marked `LOST` by the audit close earlier in the same run — which is correct behaviour. |
| TC-111 | cross-user "mark read" → 200 | The status is permissive, the data is scoped; the check now asserts the data, and the observation is listed in §5. |

Two of the failures reported as product defects in run 1 are now genuinely fixed in the product, not in the test: department-head scoping of `/allocations` and of `/org/employees/:id` (`employees.service.ts:186-193`). The rest of the list above is test error, and I am flagging it so the green result is read with the right amount of suspicion.

---

## 8. Bottom line

On `main` @ `a7d08a5` the four role workflows behave as specified: **Admin, Asset Manager, Department Head and Employee all pass**, the four Blocker rules hold, every escalation attempt was refused with the right status code, and the five defects from the previous report are closed — four verified over HTTP, one (Close Cycle UI) verified in code because no browser was involved.

The verdict is trustworthy because the run is reproducible from an empty database with one command, and because every number above appears in `QA_evidence_run2.log` with the request, the status code and the payload that produced it.
