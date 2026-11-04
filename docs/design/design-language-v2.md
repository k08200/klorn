# Design Language v2 — tokens

Status: approved by the founder 2026-10-31 (canvas "Klorn Design Language v2").
Wave 1 (this document + the token PR) puts the values below into all three
code bases. Screens migrate onto them in later waves.

This table is the single source of truth. If a platform file disagrees with
it, the platform file is wrong. The tests listed under **Guards** read the
platform files and fail when a value drifts.

## Tokens

### Colour

| Token   | Light     | Dark      | Notes |
|---------|-----------|-----------|-------|
| canvas  | `#FAFAFA` | `#0A0A0B` | The window background. Dark uses one neutral canvas on every platform (no navy). |
| surface | `#FFFFFF` | `#141416` | Panels, cards, list backgrounds. |
| raised  | `#FFFFFF` | `#1C1C1F` | Popovers and menus over a surface. The canvas gives no light value, so light raised = surface. |
| ink     | `#0B0D12` | `#F4F4F6` | Primary text. |
| ink-2   | `#3B4250` | `#A2A2AD` | Secondary text, field labels. |
| ink-3   | `#5B6270` | `#8E8E9A` | Metadata. The canvas gives no dark value; `#8E8E9A` is the existing dark ink-dim, measured ≥ 4.5:1 on every dark surface by the web token test. |
| accent  | `#0369A1` | `#38BDF8` | The one interaction colour: CTAs, focus, selection, links. Text on the fill: white (light) / `#0A0A0B` (dark). |
| hairline | `rgba(10,14,20,.08)` | `rgba(255,255,255,.08)` | 1px borders (flat depth). Control borders use `.14`. The dark value is an assumption (the canvas shows only a `.14` swatch border). |

Lanes (unchanged by v2; dot = ink on a surface, chip = chip ink on a 12% wash
of the dot colour):

| Lane    | Dot / ink | Chip ink (light) |
|---------|-----------|------------------|
| Push    | `#BE123C` | `#9F1239` |
| Meeting | `#4F46E5` | `#4338CA` |
| Queue   | `#B45309` | `#92400E` |
| Info    | `#0E7490` | `#155E75` |
| Silent  | `#57534E` | `#57534E` |

The canvas proposes `#44403C` for the Silent chip ink. The existing
`#57534E` already clears 4.5:1 on the wash (web-lane-chip-contrast test), so
it stays. Dark lane inks keep the existing per-platform values (the canvas
does not specify them).

### Radius

| Role    | Value | Use |
|---------|-------|-----|
| chip    | 6  | Lane chips, fact chips, small in-row buttons, menu items inside a popover. |
| control | 10 | Buttons, fields, segmented tracks, list rows, popovers, menus, toasts. |
| card    | 16 | Bordered cards. |
| sheet   | 24 | Sheets (top corners on phones). |

Capsules (pills, avatars, switches) stay fully rounded and are not a radius token.

### Space

4pt grid: `4 · 8 · 12 · 16 · 24 · 32 · 48`. Touch targets ≥ 44. Pointer
controls 36.

### Depth (hairline first)

| Level | Value | Use |
|-------|-------|-----|
| flat  | 1px border `rgba(10,14,20,.08)` | Default. Cards, rows, panels. |
| menu  | `0 1px 2px rgba(10,14,20,.06), 0 4px 12px -4px rgba(10,14,20,.10)` | Popovers, menus, listboxes, toasts. |
| sheet | `0 12px 32px -8px rgba(10,14,20,.18)` | Sheets, dialogs, the command palette (with a scrim). |

There are no other shadows. The same values are used in dark mode, where
the hairline does most of the work.

### Motion

| Token | Value | Use |
|-------|-------|-----|
| state | 120ms | Hover, press, toggle. |
| move  | 200ms | Popovers, toasts, anything that moves. |
| sheet | 320ms | Sheets and drawers, in and out. |
| ease  | `cubic-bezier(0.32, 0.72, 0, 1)` | Every transition. |

With Reduce Motion on, transitions are instant and nothing slides.

### Type roles

| Role    | Web (px) | Mac (pt) | Phone (px @ default size) | Weight |
|---------|----------|----------|---------------------------|--------|
| page    | 34 | 28 | 30 | 650, tracking −0.025em (web) |
| title   | 22 | 22 | 21 | 650 |
| head    | 17 | 15 | 17 | 600 |
| body    | 15 | 13 | 16 | 400 |
| label   | 13 | 12 | 14 | 500 |
| caption | 12 | 11 | 13 | 400 |
| mono    | 13 Geist Mono | 12 SF Mono | 13 | 400 |

Faces: Geist + Pretendard (Hangul) on web, Windows and phones; SF on Mac.
Phones follow the OS text size (Dynamic Type / font scale) up to 200%.

## Per-platform mapping

### Web — `packages/web/src/app/globals.css`

| v2 | CSS variable / utility |
|----|------------------------|
| canvas / surface / raised | `--surface-app` / `--surface-canvas` / `--surface-elevated` (also `bg-canvas`, `bg-surface`, `bg-raised`) |
| ink / ink-2 / ink-3 | `--ink` / `--ink-2` / `--ink-3` (`text-ink`, `text-ink-2`, `text-ink-3`) |
| accent | `--accent-solid` (`bg-accent`, `bg-accent-solid`) |
| hairline | `--hairline`, `--hairline-control` (`border-hairline`) |
| radius | `rounded-chip` / `rounded-control` / `rounded-card` / `rounded-sheet` |
| depth | `shadow-menu` / `shadow-sheet` |
| motion | `--motion-state` / `--motion-move` / `--motion-sheet`; classes `duration-120` / `duration-200` / `duration-320` + `ease-fluid` |
| type | `text-role-page` … `text-role-mono` |

The legacy type steps (`text-display` / `text-title` / `text-head` /
`text-body`, 28/20/15/14) and the legacy ink steps (`ink-strong` …
`ink-dim`) remain for page call sites until their wave. The ui primitives
(button, input, menu, sheet, toast, segmented control, listbox, lane chip)
already use the role utilities.

### Phone — `apps/mobile/src/styles/tokens.css`

| v2 | CSS variable |
|----|--------------|
| canvas / surface / raised | `--surface-app` / `--surface-card` / `--surface-raised` |
| ink / ink-2 / ink-3 | `--ink` / `--ink-2` / `--ink-3` |
| accent | `--accent` |
| radius | `--radius-chip` 6 · `--radius-control` 10 · `--radius-row` 10 · `--radius-card` 16 · `--radius-sheet` 24 |
| depth | `--hairline`, `--shadow-menu`, `--shadow-sheet` (legacy `--shadow-card` / `--shadow-float` / `--shadow-fab` map onto them) |
| motion | `--motion-state` / `--motion-move` / `--motion-sheet`, `--ease` |
| type | `--role-page` … `--role-mono` (with `-lh`); `--type-large-title` / `title` / `headline` / `body` / `callout` / `subhead` follow the roles. `--type-footnote` (12), `--type-caption` (11) and `--type-tab` (10.5) are below the role set and burn down per screen. |

### Mac — `apps/desktop-mac/Sources/KlornMac/Theme.swift`, `Shared/DesignTokens.swift`

| v2 | Swift |
|----|-------|
| canvas (dark) | `Theme.bgDark` = `#0A0A0B` |
| ink (light) | `Theme.textLight` = `#0B0D12` |
| accent | `Theme.accentSolidLight` / `accentSolidDark` |
| radius | `Theme.Radius.chip` 6 · `.control` 10 · `.card` 16 · `.sheet` 24 (rungs `sm/md/lg/xl`) |
| depth | `.elevation(.menu)` / `.elevation(.sheet)`, `Theme.hairlineOpacity` |
| motion | `Theme.Motion.state` / `.move` / `.sheet`, `Theme.Motion.fluid(_:)` |
| type | `Theme.TypeSize.*` (pure) → `Theme.Typo.page` / `title` / `head` / `body` / `label` / `caption` / `mono` |

Every Mac call site names a role (buttons and fields are `.control`); the
rungs and raw numbers stay in Theme.swift, held there by the self-check's
radius guard.

## Device classes

The window decides the class, not the device. Web, the phone app and
Windows share the thresholds. The Mac maps its window width onto them.

| Class | Width | Shell |
|-------|-------|-------|
| cover | ≤ 359 | Push only, two actions, no nav. |
| phone | 360–599 | Five bottom tabs, one column, bottom sheets. |
| phone landscape | height < 500 | Thin rail, one column, collapsed top bar. |
| medium | 600–839 | Rail + list + reader. Hinge-aware: panes split at the hinge, nothing crosses it. |
| large | 840–1199 | Collapsible sidebar + list + reader. |
| desktop | 1200–1599 | Sidebar 240, list 400, reader. Today is list + 320 rail. |
| wide | ≥ 1600 | Content max 1440, centred. Today gets a third column. |

Phones at large text sizes drop to one column earlier. Safe areas apply on
every edge. Rotating, folding or resizing never loses the open item.

## Rules

- Lane colours are the only colours besides the accent. Everything else is neutral.
- One primary button per view. Destructive red appears only at the final confirm.
- No model names anywhere in the UI.
- No unmeasured claims in copy. Real dates, real counts, real states.
- Every lane decision shows its reason and quotes the mail.

## Guards

- `packages/api/src/__tests__/web-design-tokens-v2.test.ts`: web values, AA
  for the ink ramp, exactly two shadow tokens, role utilities, and the ui
  primitives on the v2 system.
- `packages/api/src/__tests__/web-lane-chip-contrast.test.ts`: chip ink AA.
- `.github/scripts/check-design-tokens.mjs`: burn-down rules. `shadow-l2` and
  `shadow-l3` are retired with zero allowance.
- `apps/mobile/src/styles/tokens.test.ts`: phone values, identical dark
  blocks, no navy literal left in the app.
- `KlornMac --self-check` (SelfCheckTokens.swift): Mac radii, depth, motion,
  type sizes, canvas, ink and accent.
