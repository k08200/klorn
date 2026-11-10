# Web polish plan — audit and phased execution

Audited 2026-08-13 against `main` (post-hardening, `42c81376`). Full-app pass over
`packages/web` user surfaces ("SaaS 사용 페이지 전체" — founder scope, 2026-08-13).
This document is the canonical tracker; strike items as PRs merge.

## Audit summary (what's actually wrong)

**States & a11y (worst gap)**
- 20 files with interactive elements have zero focus styling; `.focus-ring`
  exists in globals.css but adoption is thin (65 uses app-wide).
- Six core surfaces show text-only "Loading..." (briefing, email detail,
  candidates, receipt, graph, chat); `LoadingState`/`Skeleton` components exist
  but have 1–2 importers.
- `/billing` surfaces errors only as toasts; no inline error state.

**Consistency**
- The inline error box (`border-red-200 bg-red-50`) is re-implemented in 24
  files while `ui/error-alert.tsx` has exactly 1 importer.
- Two card languages: `panel-elevated rounded-2xl border-slate-200/70` (×84)
  vs the `ui/card.tsx` recipe `rounded-xl border-slate-200` (×46).
- Accent token bypassed 4:1 — raw `sky-*` ×608 vs `*-accent*` ×140.
- Two h1 recipes split across mobile/desktop trees; heading scale is
  arbitrary-value dominated (`text-[11px]` ×212, `text-[10px]` ×102).
- 7 of 13 `ui/` primitives have zero importers (card, badge, tabs, modal,
  empty-state, page-header, responsive-table).
- `/settings` ships private `PRIMARY_BTN`/`PANEL` string constants duplicating
  the ui library it never imports.

**Feature gap**
- `GET /api/usage` (+ `/conversations`) returns summary, daily series and
  per-conversation cost attribution — consumed by ZERO web UI. The only
  user-visible cost figure is one aggregate chip on /billing. Cost caps are a
  core positioning claim; users cannot see their usage.

**Deliberately deferred (separate founder decisions)**
- Dark mode: does not exist (`dark:` ×0). Full introduction is a project of
  its own — not started here.
- i18n: 22 of 32 pages hardcode English; `lib/i18n` half-applied. Separate
  track.
- `/settings/sms` is ADMIN-gated but lives under a user route — relocation
  candidate, needs founder call.

## Phased execution (one PR each)

- **A — states & a11y floor**: focus-ring everywhere interactive, min-h-11
  touch targets, text-only loading → `LoadingState`/skeletons,
  `tabular-nums` on billing numbers, dark-theme color leftovers fixed
  (status-chip/badge/error page).
- **B — one error language**: adopt `ui/error-alert` at all 24 inline sites.
- **C — usage dashboard**: consume `/api/usage` — summary tiles, daily
  series, per-conversation table, week/month/all periods. Home: `/usage`
  linked from billing + sidebar (the old `/settings/usage` route referenced
  by `ui/responsive-table.tsx:12` no longer exists).
- **D — typography & surface unification**: single h1 recipe, heading scale
  in `@theme`, one card language, migrate `sky-*` hot spots to the accent
  token (mechanical sweep, verified per page).
- **E — dead code**: delete or adopt the 7 zero-importer ui primitives;
  fix the stale `/settings/usage` docstring.

Rules for every PR: work within Tailwind v4 CSS-first setup (no config file),
no new dependencies without checking package.json, no framework migration,
WCAG 2.2 AA floor, web typecheck + root biome + `pnpm -r build` green, visual
verification on the changed surfaces before merge.
