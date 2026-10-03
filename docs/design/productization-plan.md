# Productization plan: information architecture, design system, macOS, website

Status: **LOCKED 2026-10-02** (founder approved all FD-1..FD-9 as recommended).
Grounded against `main` @ `03960f14`.

Related documents:

- `docs/providers/unified-platform-plan.md` — the multi-provider platform this
  plan presents (sources, Files, team free-time).
- `docs/design/web-polish-plan.md` — the 2026-08-13 web audit. Where this plan
  conflicts with it, **this plan supersedes**.
- `docs/product-vocabulary.md` — canonical word list, updated with this plan.
- `apps/desktop-mac/REBUILD_BLUEPRINT.md` — superseded in part (see macOS).

Flag names below are **proposed**; none exist in code yet. All ship OFF by
default and are flipped as separate decisions.

## 1. Information architecture

Primary nav on every platform: **Today** · **Mail** · **Calendar** · **Files**
(only when a drive source is connected or its flag is on) · **Assistant** (chat,
Approvals, Briefing, Receipt). Settings live in the account menu.

**Today** (home): mail by lane across all accounts — PUSH and MEETING expanded,
QUEUE as count plus top 5, INFO collapsed, SILENT never shown — plus a merged
calendar (source-coloured, conflicts flagged), recent files (flag), and an
assistant strip (briefing paragraph, N approvals, ask box; "when is everyone
free" only with team mode).

`/inbox` widgets: drop PmfCard, CommandCenterSummary, QuickLinks, SignalStrip.
ReplyNeeded moves to Today; Screener and Commitments move to Approvals;
Briefing moves to Assistant.

**Accounts**: one unified list with a **SourceBadge** on every row and event, an
account facet chip, and a sidebar Accounts group showing health (synced,
syncing, needs re-auth, last sync, "Actions limited" for read-only IMAP).

**Mail**: lane segmented control PUSH · MEETING · QUEUE (default) · INFO · All;
SILENT only via "Show silenced". The separate Firewall board screen is retired;
the lane view is Mail. Domain tiles are removed. A row shows LaneChip,
SourceBadge, unread dot and attachment glyph only; needs-reply, category and
why-this-lane move to the reader header.

**Settings** (`/settings/[section]`): Accounts & sources · Lanes & rules ·
Assistant (agent mode, replies, BYOK) · Notifications · Team · Integrations
(MCP keys, Telegram) · Appearance & language · Account & billing · Data &
privacy. Manual runs and SMS move to admin.

## 2. Design system

Type (web px/line-height/weight | mac pt):

| Role | Web | Mac |
|---|---|---|
| display | 28/34/600 | 22 |
| title | 20/28/600 | 17 |
| head | 15/22/600 | 15 |
| body | 14/21/400 | 13 |
| label | 13/18/500 | 12 |
| caption | 12/16/400 | 11 |

Retire 10px text. Tabular numerals. Korean uses `word-break: keep-all`.

Spacing 4/8/12/16/24/32/48. Row height 52 desktop, 64 touch.
Radii: 6 controls, 10 rows/cards/popovers, 16 sheets/windows. Capsule shape only
for pills and LaneChip.

Colour: hue-free neutrals matched to `Theme.swift`; one accent, sky
(`#0369a1` light / `#38bdf8` dark). Lane colours are identical on web and mac
(fixes INFO resembling SILENT and the MEETING teal mismatch):

| Lane | Dark | Light |
|---|---|---|
| PUSH | `#fb7185` | `#be123c` |
| MEETING | `#818cf8` | `#4f46e5` |
| QUEUE | `#fbbf24` | `#b45309` |
| INFO | `#22d3ee` | `#0e7490` |
| SILENT | `#a8a29e` | `#57534e` |

SourceBadge is a neutral monochrome glyph (G, M, N, iC, IMAP, K). Calendar colour
is a 3px left bar. Category labels are neutral.

Elevation: L0 canvas, L1 hairline, L2 `0 8 24 12%`, L3 `0 24 48 18%` plus 40%
scrim. Glass only on the pill, floating cards and the command palette.

Motion: 120ms state, 200ms enter, 160ms exit, `--ease-fluid`; springs only on the
mac pill; reduced-motion falls back to fade.

Component order: Button (adopt `ui/button`, drop shadow and lift), ListRow /
MailRow, LaneChip, SourceBadge, EmptyState, Skeleton (loading only), Sheet,
CommandPalette (actions plus "Ask:"). Lint guard: no new `text-[Npx]`, raw
palette values, or raw `<button>` in `app/**`.

## 3. Interaction

Keys: `j/k`, `o/Enter`, `Esc`, `e` (if the source supports it), `r/a/f`, `c`,
`1`–`5` lane (reclassify only via `overrideAttentionTier`), `z/Cmd+Z`, `x` with
`Shift-j/k`, `/`, `?`, `g t/m/c/f/a/s`, `Cmd+K`, `Cmd+Enter`. A single registry
feeds the `?` sheet and the palette; mac `.commands` come from the same table.

Actions are optimistic with a 6s undo toast. Undoing a lane override must
reverse the ledger and the sender prior; this needs an API change in
`judge/attention-override.ts` and `learning/sender-policy.ts`.

First run: sign in, provider grid (flag-on providers only, honest scope), live
per-account sync counts, Today filled with the first briefing, then add another
account. Mac first launch shows an onboarding window.

## 4. macOS architecture (FD-5)

The pill and expanded states stay `NSPanel`. The full view becomes a standard
`Window` scene with `NavigationSplitView`, `List(selection:)`, toolbar search and
`.commands`; Settings is a `Settings` scene (`TabView`); Compose is a
`WindowGroup`; editors are sheets. Activation policy switches `.accessory` to
`.regular` while the window is open. `ListMode` becomes the 5 nav items.

This reverses the HUD-only full view in `REBUILD_BLUEPRINT.md` §2/§4.

| Step | Scope |
|---|---|
| M0 | Settings scene |
| M1 | `.commands` |
| M2 | Window scene behind `macMainWindow` (proposed), default OFF |
| M3 | `List(selection:)` plus keymap |
| M4 | `NavigationSplitView`; split `TopBar.swift` (2 PRs) |
| M5 | Compose window and sheets |
| M6 | Logged-out, error and onboarding states |
| M7 | Tokens |
| M8 | Flip the flag; delete `BarState.full` |

`REBUILD_BLUEPRINT.md` is rewritten after M-series sign-off.

## 5. Website (6 sections)

1. **Hero**: outcome claim and a real Mac Today loop with Gmail/Outlook/Naver
   badges; "All your mail and calendars. One calm place."; CTAs Download for Mac
   and Open in browser; "$8.99/mo · bring your own AI key". No CI, AGPL, eval or
   competitor mentions here.
2. **Every account, one view**: connector strip with honest status (Available /
   Beta / Via phone app / Coming).
3. **Five lanes, with the reason**: three real rows.
4. **Your day, merged, plus assistant**: "everyone free" is labelled Teams /
   Coming.
5. **Proof and trust band**: measured numbers only, linking to `/open-source`,
   `/security`, `/methodology`.
6. **Pricing**, 5-question FAQ, final CTA.

Comparisons go to `/vs/*`; the works-with checklist to the download page;
footnotes to methodology. One subpage template. Social proof: founder note and
photo, 3–5 quotes with permission.

Founder-supplied assets: seeded demo accounts (Gmail, Outlook test tenant,
Naver), 4K Mac recordings, iPhone captures, founder photo and note, quotes,
logo-use approval, legal check of connector claims.

## 6. Roadmap

| Phase | Scope | Proposed flag |
|---|---|---|
| P0 | Decisions and vocabulary doc (this PR) | — |
| P1 | Tokens and lint guard | — |
| P2 | Primitives (2 PRs) | — |
| P3 | Settings split | — |
| P4 | Hotkeys, undo, optimistic updates, reversible override | `KEYBOARD_TRIAGE` |
| P5 | Mail v2 (2 PRs) | `MAIL_V2` |
| P6 | Today home | `UNIFIED_HOME` |
| P7 | Assistant hub and `/inbox` redirect | `UNIFIED_HOME` |
| P8 | Multi-provider onboarding | `ONBOARDING_V2` |
| P9 | Mac M0–M8 (parallel, any time after P1) | `macMainWindow` |
| P10 | Mobile tabs and swipe | — |
| P11 | Website rebuild (3 PRs) | — |
| P12 | Files tab, Teams free-time | — |

## 7. Decisions (all LOCKED, approved as recommended)

| ID | Decision |
|---|---|
| FD-1 | Home = **Today**; Decision queue becomes **Approvals** under Assistant (vocabulary change) |
| FD-2 | Unified list with source badges; no account switcher |
| FD-3 | Retire the separate Firewall board screen; lanes are Mail's primary filter |
| FD-4 | One lane palette on both platforms and a neutral app canvas (drop the indigo wash) |
| FD-5 | Mac gets a real main window (reverses the 2026-07-07 HUD blueprint); the pill stays |
| FD-6 | Competitors, AGPL and CI leave hero and meta; they live in `/vs` and the trust band |
| FD-7 | Files appears in nav only when a source is enabled |
| FD-8 | Nav name is "Assistant" (alternative considered: "Klorn") |
| FD-9 | Publish founder photo and quotes; demo-data policy for marketing captures |
