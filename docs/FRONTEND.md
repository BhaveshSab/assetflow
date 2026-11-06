# The frontend — how it is built and why

A single-page application in React 18 + TypeScript, served by Nginx (or by
Vercel) and talking to the NestJS API under `/api`.

| | |
|---|---|
| **Source** | 56 files, ~14,900 lines (including ~1,050 lines of tests) |
| **Stack** | React 18.3 · TypeScript 5.6 (`strict`) · Vite 5 · Tailwind 3 · React Router 6 · Recharts 3 · Framer Motion 12 · lucide-react |
| **Tests** | 67 Vitest tests in 9 files (unit + component, jsdom) |
| **Lint** | ESLint 9 · `react-hooks` · `react-refresh` · `typescript-eslint` |
| **First load** | **143 kB gzipped** (React 49, Motion 41, vendor 28, app 8, icons 7, CSS 9); the **96 kB gzipped** Recharts chunk is fetched only when a chart is drawn |
| **Screens** | 12 lazily-loaded views — 9 navigation screens + 3 role dashboards (admin / manager / employee) — reached from 10 sidebar entries, plus 2 auth routes |
| **Theme** | light and dark, from CSS variables; the choice is remembered and follows the OS until it is made |

---

## 1. The shape of the app

```
src/
├── App.tsx                  the router: /signin, /signup, /Dashboard (lazy)
├── pages/
│   ├── Dashboard.tsx        the shell: role guard, view switching, badge polling
│   ├── AuthPage.tsx         sign in / sign up, honours ?next=
│   └── AuthLayout.tsx
├── components/
│   ├── ui/                  the kit: dialog, field, search-dropdown, error-boundary, theme-toggle, …
│   └── dashboard/           10 views + the sidebar, the header, the bell, the modals
├── hooks/usePolling.ts      one poller for all five of them
├── lib/
│   ├── api.ts               the only fetch wrapper (timeout, errors, 401)
│   ├── auth.ts              sign in / up / me
│   ├── session.ts           the stored session (no import cycle)
│   └── utils.ts             cn(), errorMessage()
└── types/api.ts             the raw API records + the reading helpers
```

---

## 2. The decisions worth explaining

### 2.1 One fetch wrapper, and the failure paths are named

`src/lib/api.ts` is the only place that calls `fetch`. It gives every request:

* a **20 s timeout** (`AbortController`) — a hung request is a spinner that
  never ends, which looks exactly like a broken page,
* **one error shape** — the API's validation array becomes its first message,
  a 401 becomes "Your session has expired", an unreachable backend becomes
  "Could not reach the AssetFlow API at `<url>`",
* **the Authorization header only when there is a session** — sending
  `Bearer ` (empty) would turn a public request into a 401,
* **a 401 side effect** — the session is cleared and the user goes to
  `/signin?next=<the page they were on>`; the `next` value is validated to a
  local path so it cannot be used as an open redirect.

### 2.2 The types describe what the API sends, not what the UI hopes

A backend record is an `ApiRecord` (`Record<string, unknown>`), and its fields
are read through `fieldStr` / `fieldNum` / `field` (`src/types/api.ts`).
Those helpers always return the declared type, so a field the API did not send
becomes `""` or `0` — never `undefined` rendered as an empty cell. `any` is a
lint error.

### 2.3 The overlays are one kit

`Dialog` (`src/components/ui/dialog.tsx`) implements the modal pattern once:
`role="dialog"`, `aria-modal`, an accessible name, a focus trap, Escape, the
focus returned to the opener, the page behind frozen, and a portal so no
ancestor can clip it. `ConfirmDialog` builds on it for destructive actions,
`Field` gives every input a real label and an announced error, and
`SearchDropdown` is the WAI-ARIA 1.2 combobox.

### 2.4 Polling is one hook

`usePolling(callback, intervalMs, enabled)`:

* a tick is skipped while the previous request is still in flight (otherwise
  the answers arrive out of order and the screen jumps back to older data),
* nothing runs while the tab is hidden, and a refresh happens the moment it
  becomes visible again,
* the callback lives in a ref, so a function re-created on each render does
  not restart the timer.

### 2.5 The bundle is split by what a screen needs

The views are `React.lazy` + `Suspense` (with an announced "Loading…"), and
`vite.config.ts` puts React, Recharts, Framer Motion and the icons in their
own chunks so a change to a view does not invalidate the libraries in the
browser cache.

| Before | After |
|---|---|
| one file, 1,089 kB (294 kB gzipped) | **143 kB gzipped first load** (React 49 + Motion 41 + vendor 28 + app 8 + icons 7 + CSS 9), then one 4–10 kB file per view |
| Recharts in the first load | a **96 kB gzipped** charts chunk, requested when a chart is drawn |

**The recharts chunk was still being preloaded until 2026-11-05.** The chunk
list named the packages (`charts: ["recharts"]`), and Rollup put recharts'
*dependencies* — `clsx`, which the shell's `cn()` helper needs — into that same
chunk. The entry therefore had a static import of the charts chunk, Vite
emitted `<link rel="modulepreload">` for all of it, and every visitor
downloaded 118 kB gzipped of charting library before the sign-in page painted.
Assigning chunks by module path (`vite.config.ts`) fixed it: first load went
from **247 kB to 143 kB gzipped**.

### 2.6 Light and dark are one set of tokens, not two stylesheets

Every colour in the interface is a CSS variable, declared twice in
`src/index.css` — `:root` for light, `.dark` for dark — and exposed to Tailwind
as `bg-surface`, `text-ink-muted`, `border-line`, `text-success`, … A component
that says `bg-surface text-ink-muted` is therefore correct in both themes and
carries no `dark:` variant at all.

```css
:root  { --canvas: 228 40% 97%; --surface: 0 0% 100%; --ink: 222 47% 11%; … }
.dark  { --canvas: 228 28% 8%;  --surface: 231 27% 14%; --ink: 220 33% 98%; … }
```

How the class gets there, in order: a saved choice in
`localStorage["assetflow-theme"]`, otherwise `prefers-color-scheme`, otherwise
light. `src/lib/theme.ts` is the only place that decides, `useTheme()` keeps the
switch in step, and a six-line inline script in `index.html` paints the class
*before* the bundle is fetched — a dark-mode visitor never sees a white flash.
`<html style="color-scheme">` is set too, so the scrollbar and the native form
controls follow.

The switch itself (`src/components/ui/theme-toggle.tsx`) is in the app header
and on both auth screens; it is a button with `aria-pressed` and a label that
names the action ("Switch to dark theme"), so it is announced correctly and is
operable with Enter and Space.

**What this replaced:** the interface was built against one hard-coded dark
palette — 978 `zinc`/`gray` utilities, 282 arbitrary navy values
(`bg-[#1a1d2e]` and friends) and 1,088 hue utilities spread over 26 files, with
a `.dark` block in the CSS that nothing ever switched on. `scripts/theme-refactor.py`
did the mechanical part (it is idempotent, and documents every mapping), and
the result is a single set of tokens. The dark theme is the same design as
before to within a shade or two; the light theme is new.

**Why it was worth the churn:** the second theme is now a 12-value table, and
the two rows can be tuned for contrast without touching a component.

### 2.7 The roles are decided by the API, never by the token

The role is re-read with `GET /auth/me` on every dashboard mount, and every
request is authorised server-side against the current user record. A role
change or a deactivation takes effect without a redeploy; the token carries
no authority of its own.

---

## 3. What the tests cover — and what they do not

| Covered (67 tests) | Not covered |
|---|---|
| the API client: headers, timeout, error messages, 401 handling | the views' rendering |
| the auth client: session storage, `getMe`, expiry | the charts |
| the dialog: role, name, focus trap, Escape, restore, scroll lock | the routing |
| the combobox: roles, arrow keys, Home/End, Enter, Escape, live count | visual regressions |
| the polling hook: overlap, hidden tab, cleanup | a real browser / a real screen reader |
| the error boundary: fallback, retry | |
| the theme: stored choice beats the OS, OS is followed when nothing is stored, the class and `color-scheme` are applied, a blocked storage does not throw, the storage key matches `index.html` | whether the *light* palette looks right on every screen (no visual test) |

The tests run in jsdom: they prove attributes and behaviour, not pixels. The
next step is Playwright for the routes and axe for the accessibility rules —
both listed in `docs/ACCESSIBILITY.md`.

---

## 4. Running it

```bash
npm install
npm run dev          # http://localhost:5173, expects the API on :4000
npm run lint         # ESLint (fails on errors; 16 known advisories are listed)
npm run typecheck    # tsc -b, strict
npm test             # 67 Vitest tests
npm run build        # tsc -b && vite build → dist/
```

`VITE_API_BASE_URL` is read in exactly one place (`src/lib/api.ts`). In the
self-hosted build it is `/api` (same origin, no CORS); in the Vercel build it
is the backend origin, with `/api` on the end.
