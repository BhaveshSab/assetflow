# Accessibility (WCAG 2.1 AA) — AssetFlow frontend

The frontend is a single-page application used by three kinds of people: an
administrator who manages the inventory, an asset manager who approves
transfers, and an employee who books a room. All three may work with a
keyboard, a screen reader, a magnifier, or none of those.

This document records **what is implemented, how it is verified, and what is
still missing.** Nothing in the left-hand column is a claim about the whole
product: each row names the behaviour that exists and the test or the file
that proves it.

---

## 1. The conformance target

**WCAG 2.1 level AA.** Level AAA is not claimed (it requires, among other
things, sign-language interpretation and a contrast ratio of 7:1, which this
dark dashboard does not meet by design).

Section 508 is satisfied by WCAG 2.0 AA conformance, which is a subset of the
2.1 AA work below.

---

## 2. What is implemented

### 2.1 Perceivable

| Criterion | What the app does | Where |
|---|---|---|
| **1.1.1 Non-text content** | Every icon is `aria-hidden` when it sits next to a text label; every icon-only button has a name (`aria-label`). The avatar is a `div` with the initials hidden from the screen reader and the full name given as text. | `src/components/dashboard/TopHeader.tsx`, `Sidebar.tsx`, the close buttons in `src/components/ui/dialog.tsx` |
| **1.3.1 Info and relationships** | Form controls have a real `<label for>`; the tables use `<th scope>`; the page has `header` / `nav` / `main` landmarks; the navigation is a `nav` with a name. | `src/components/ui/field.tsx`, `DashboardLayout.tsx`, `Sidebar.tsx` |
| **1.3.2 Meaningful sequence** | The DOM order is the visual order; the sidebar comes before the content in the tab order and the skip link jumps over it. | `DashboardLayout.tsx` |
| **1.4.3 Contrast (minimum)** | Text in the dashboard is `zinc-300`/`zinc-400` on `#0f111a`–`#1a1d2e` (≥ 7:1 for the body text, ≥ 4.5:1 for the secondary text). Status colours are always paired with a word, never colour alone. | `src/index.css`, the status badges |
| **1.4.10 Reflow** | Layouts are single-column up to 640 px, the tables scroll horizontally inside their card instead of pushing the page, and no content needs a horizontal scroll of the page itself. | the `sm:` / `md:` / `lg:` breakpoints |
| **1.4.4 Resize text** | Sizes are in `rem`/`em` through Tailwind, so a 200% browser zoom reflows instead of clipping. Fields are 16 px on a phone so iOS does not zoom the page. | `src/index.css` |

### 2.2 Operable

| Criterion | What the app does | Where |
|---|---|---|
| **2.1.1 Keyboard** | Every action is reachable and operable from the keyboard: the dialogs trap the focus, the combobox has arrow keys / Home / End / Enter / Escape, the drawer opens with the menu button and closes with Escape. | `src/components/ui/dialog.tsx`, `search-dropdown.tsx` |
| **2.1.2 No keyboard trap** | The focus cannot leave a dialog while it is open (that is intended) and Escape always closes it — so the trap is escapable. | `dialog.tsx` (8 tests) |
| **2.4.1 Bypass blocks** | A skip link is the first element in the tab order and moves the focus to `<main id="main-content" tabindex="-1">`. | `DashboardLayout.tsx` |
| **2.4.3 Focus order** | The focus moves into a dialog when it opens, cycles inside it, and **returns to the element that opened it** when it closes. | `dialog.tsx`, proven in `dialog.spec.tsx` |
| **2.4.7 Focus visible** | A 2 px outline with an offset on every `:focus-visible` element; nothing sets `outline: none` without a replacement. | `src/index.css` |
| **2.5.3 Label in name** | The accessible name of a control contains its visible text (the close buttons say "Close", the refresh button says "Refresh"). | the icon buttons |

### 2.3 Understandable

| Criterion | What the app does | Where |
|---|---|---|
| **3.3.1 Error identification** | A validation error is shown under its field, marked `aria-invalid` on the control and referenced by `aria-describedby`. | `src/components/ui/field.tsx` |
| **3.3.2 Labels or instructions** | Required fields are marked visibly (`*`) **and** announced ("(required)"). | `field.tsx` |
| **3.3.3 Error suggestion** | Messages are sentences, not codes: "The request timed out. Please try again.", "Could not reach the AssetFlow API at …", the API's own validation message otherwise. | `src/lib/api.ts`, `src/lib/utils.ts` (`errorMessage`) |
| **3.2.3 Consistent navigation** | One `Sidebar` renders the same navigation on every view, in the same order, with `aria-current="page"` on the active item. | `Sidebar.tsx` |

### 2.4 Robust

| Criterion | What the app does | Where |
|---|---|---|
| **4.1.2 Name, Role, Value** | Dialogs are `role="dialog"` + `aria-modal="true"` + a name; the combobox is `role="combobox"` with `aria-expanded` / `aria-controls` / `aria-activedescendant`; its list is `role="listbox"` of `role="option"` with `aria-selected`. | `dialog.tsx`, `search-dropdown.tsx` |
| **4.1.3 Status messages** | Errors and the "N results" of a search are `role="alert"` / `role="status"` + `aria-live`, so they are announced without stealing the focus. | 12 error banners + the combobox |

### 2.5 Other things that make it usable

* **An error boundary** keeps one broken view from blanking the whole app and
  offers "Try again" and "Reload" (`src/components/ui/error-boundary.tsx`).
* **An expired session** is not a dead end: a 401 clears the session and
  returns the user to `/signin?next=<the page they were on>`
  (`src/lib/api.ts`).
* **A destructive action asks first** — rejecting a transfer, rejecting a
  maintenance request, cancelling a booking — in a dialog that a screen
  reader can use (`ConfirmDialog`).
* **Polling stops when the tab is hidden** and never overlaps itself, so a
  background tab does not hammer the API (`src/hooks/usePolling.ts`).
* **Motion** is limited to short spring transitions; nothing flashes more
  than three times per second, so **2.3.1 Three flashes** is not triggered.

---

## 3. How it is verified

| Evidence | What it proves |
|---|---|
| **52 unit tests in 7 files** (`npm test`) | The dialog's role, name, focus trap, Escape, focus restore, backdrop and scroll lock (8 tests); the combobox's roles, arrow keys, Home/End, Enter, Escape, live result count and keyboard-only opening (7 tests); the 401 handling including the no-loop case (2 tests); the polling hook's overlap guard, hidden-tab behaviour and cleanup (6 tests); the error boundary (3 tests). |
| **`npm run lint`** (ESLint 9 + `eslint-plugin-react-hooks`) | A missing dependency in an effect — the classic source of a stale label or a stale redirect — fails the build. |
| **`npm run typecheck`** (`tsc -b`, `strict`) | No `any` in `src/` (enforced by the lint rule), so a renamed API field is a compile error rather than a blank cell. |
| **Manual keyboard pass** | Tab through sign-in → dashboard → open a dialog → Escape → open the combobox with the arrow keys. Done in the development build during this work. |

> **Honest limits.** The tests run in jsdom, which has no layout engine and
> no accessibility tree: they prove the **attributes and the focus
> behaviour**, not the rendering. No automated axe scan and no NVDA /
> VoiceOver / TalkBack session has been recorded yet — that is the next step
> (§5).

---

## 4. Known gaps

| Gap | Why it matters | The fix |
|---|---|---|
| **No axe / Lighthouse a11y audit recorded** | A rule-based scan finds what a person misses (a contrast pair, a duplicate id, a missing `scope`). | `@axe-core/playwright` on the four main routes, in CI. |
| **No screen-reader session on record** | Attributes can be right while the experience is still confusing. | One NVDA + Firefox and one VoiceOver + Safari pass, recorded as a checklist in this file. |
| **The 24 charts are not described** | A chart is a picture; a screen-reader user gets nothing from a `<svg>`. | `role="img"` with an `aria-label` summarising the series, plus the same numbers in a `<table>` behind a "View as table" toggle. |
| **The toasts disappear after 3 s** | Someone reading slowly, or using a screen reader, may miss it. | `role="status"` (already) + a "dismiss" button and a longer timeout. |
| **16 `react-hooks/set-state-in-effect` warnings** | Each view sets `loading` and fetches in an effect. It works, but React's newer guidance prefers a data library. | Move the fetches to TanStack Query (or `useSyncExternalStore`) — a refactor of the 13 data views, tracked in `docs/DECISIONS.md`. |
| **Colour contrast is by token, not by measurement** | The palette was chosen to pass; it has not been measured element by element. | A contrast check of the eight tokens with a tool, recorded here. |

---

## 5. The order of the next work

1. **axe in CI** on sign-in, dashboard, asset directory and reports — the
   cheapest way to keep regressions out.
2. **The charts as tables** — the biggest real barrier for a screen-reader
   user on this app.
3. **One recorded screen-reader pass**, with the findings listed here.
4. **The toast** keeps its message until it is dismissed.
5. **A measured contrast table** for the eight colour tokens.

---

## 6. For the interview

*"What does accessibility mean in your project?"*

> It is a set of concrete behaviours, not a badge. A dialog announces itself,
> traps the focus and gives the focus back when it closes; a form field is
> connected to its label and its error; an icon button has a name; a page can
> be skipped. Eight tests prove the dialog's behaviour and seven prove the
> combobox's, because those are the two places where a keyboard user gets
> stuck. What I have **not** done is an axe scan or a recorded screen-reader
> session — that is in the known-gaps table, with the order I would fix it in.

*"Why not a component library like MUI?"*

> The overlays and the fields became a small internal kit (`Dialog`,
> `ConfirmDialog`, `Field`, `SearchDropdown`) — four files, the same behaviour
> in every place, tested once instead of per screen. A full library would
> have brought the same behaviour plus a theme to fight; this dark dashboard
> is already a design system of its own.
