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

Flags (status as of 2026-10-09). All ship OFF by default and are flipped as
separate decisions:

| Flag | Step | Status |
|---|---|---|
| `KEYBOARD_TRIAGE` | P4 | In code, default OFF |
| `MAIL_V2` | P5 | In code, default OFF |
| `UNIFIED_HOME` | P6 (Today), P7 (Assistant hub) | In code for P6, default OFF; P7 not built |
| `macMainWindow` | P9 (M2–M8) | In code (desktop), default OFF |
| `ONBOARDING_V2` | P8 | In code, default OFF |

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

### Tokens and guard (P1, shipped)

Web tokens live in `packages/web/src/app/globals.css`:

| Token | Utility | Value |
|---|---|---|
| Type roles | `text-display` `text-title` `text-head` `text-body` `text-label` `text-caption` | the table above (size, line-height and weight in one class) |
| Radii | `rounded-control` (r-sm) `rounded-card` (r-md) `rounded-sheet` (r-lg) | 6 / 10 / 16 px; capsule stays `rounded-full` |
| Elevation | `shadow-l2` `shadow-l3` | `0 8px 24px rgb(0 0 0 / .12)` / `0 24px 48px rgb(0 0 0 / .18)` |
| Motion | `duration-120` `duration-200` `duration-160` + `ease-fluid` | `--motion-state` / `--motion-enter` / `--motion-exit` |
| Spacing | Tailwind default scale `1 2 3 4 6 8 12` | 4/8/12/16/24/32/48, no new tokens |

The radii are named by role rather than overriding `rounded-sm/md/lg`, which
would restyle every existing call site. The sky/indigo wash on the app body is
gone in both themes. The light canvas (`--surface-app`) is hue-free `#fafafa`
(Theme.swift `bg`); the dark canvas stays navy because every dark panel value
is navy, and the dark ramp moves to neutral as one set. The slate-tinted ink,
line and panel ramps keep their measured contrast values until P2 re-measures
those pairs.

`.github/scripts/check-design-tokens.mjs` (CI Lint job, "Design tokens") counts
four rules per file in `packages/web/src/app/**` and `components/**`:
`arbitrary-font-size` (`text-[Npx]`), `raw-palette` (`bg-slate-100` etc.),
`raw-button` (`<button` in `app/**`) and `retired-auto-lane` (`tier-auto`).
Each file may not exceed its count in `.github/scripts/design-tokens-baseline.json`,
and a file not listed is allowed zero. After migrating call sites, run
`node .github/scripts/check-design-tokens.mjs --update` and commit the smaller
baseline with the change. `--update` refuses to run while any count is above
its baseline, so the numbers only go down. Never raise a count by hand.

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

### First run on the web (P8, shipped behind `ONBOARDING_V2`)

`/onboarding` renders the multi-provider first run only when the server says so
(`user.onboardingV2` on `GET /api/auth/me` and the login/register responses);
otherwise it is the earlier four-step flow, unchanged. Four steps: accounts,
sync, check, done.

The grid draws one tile per entry of `GET /api/providers/available` (dark, the
default 404, while the flag is off) that the web has a connect flow for:

| Tile | Listed when | Scope the tile states | Connect flow |
|---|---|---|---|
| Google | always | Gmail and Google Calendar; a second account (only with `MULTI_INBOX_SYNC_ENABLED`) brings mail only | existing OAuth start |
| Microsoft | `OUTLOOK_INBOX_ENABLED` and the app registration is present | Outlook and Microsoft 365 mail | existing OAuth start |
| Naver | always | Naver Mail; "read-only" unless an IMAP write flag is on | Settings' credential form, in a Sheet |
| iCloud | `ICLOUD_INBOX_ENABLED` | iCloud Mail; "read-only" unless an IMAP write flag is on | Settings' credential form, in a Sheet |

A tile claims only what pressing it connects. The server also reports whether
it reads a provider's calendar (`OUTLOOK_CALENDAR_ENABLED`,
`CALDAV_CALENDAR_ENABLED`), but the web has no connect flow for those calendars
yet, so no tile names them. Generic IMAP (`GENERIC_IMAP_ENABLED`) is reported
too and has no tile for the same reason: the web has no form for it.

The sync screen shows read numbers only. The primary account's come from its
sign-in sync; every account's message count and the lane totals come from
`GET /api/email/lane-counts?inbox=`, which exists while `MAIL_V2` or
`UNIFIED_HOME` is on. Without it, or for a user with no Google grant (the route
answers sample data), a row says it has no count.

OAuth callbacks still land on `/settings?google=…|inbox=…`. A connect started
from the first run leaves a sessionStorage marker holding one of two fixed
provider names and the time it was written (ignored after 15 minutes); Settings
reads the callback's status against a fixed list and
sends the visitor to the constant route `/onboarding`, which shows the result.
Nothing in the URL chooses a destination and `safeNextPath` is untouched.

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
