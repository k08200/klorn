# Klorn — native macOS app

A **real native macOS client** of the Klorn firewall (SwiftUI), not a webview
wrapper. It lives as a **custom always-on bar pinned to the top-center of your
screen** — a slim pill you can glance at, that expands into the full firewall on
demand. It never steals focus from whatever you're working in: the whole point
is to surface what matters without knocking you out of your flow.

This replaces the old Electron `packages/desktop` shell. It's a Swift Package
(text-based, reproducible, diffable) rather than an `.xcodeproj` — a deliberate
deviation from the repo's "TypeScript only" lock, chosen for a genuinely native
app (the classification engine in `@klorn/api` stays the moat, served to every surface via the API).

## What it looks like

- **Collapsed** — a dark rounded pill at the top-center: `☰ · Klorn · live state`
  (PUSH count when signed in, `Log In` when not). Always visible, always
  glanceable. No Dock icon, no system-menu-bar item (it's an `.accessory` app).
- **Expanded** — click `☰` (or press `⌥⌘K`) and the pill morphs down into a
  3-column panel:
  - **INBOX** — the lane counts, click to open the web inbox. The five live
    lanes (PUSH / MEETING / QUEUE / INFO / SILENT) always draw, zero-count
    included — the sidebar *is* the classification scheme, so an empty MEETING
    row is information. Retired `AUTO` joins them only while old rows remain
    (`Tier.visibleOrder(counts:)` in `Models.swift`).
  - **RECENT PUSH** — the items that need you, each with **Open · Snooze · Dismiss**.
  - **ACCOUNT** — open web inbox, sign out, quit.
- Click `— Close` (or `⌥⌘K` again) to collapse back to the pill.

Because the panel is a non-activating floating window, it appears and expands
**without stealing keyboard focus** — you keep typing in your editor while it's up.

## Run

The app talks to the Klorn API. Point it at local dev or prod:

```bash
cd apps/desktop-mac

# against local dev (api on :3001 — the default)
swift run KlornMac

# against prod (the API host — NOT app.klorn.ai, which only serves the web UI)
KLORN_API_URL=https://klorn-api.onrender.com swift run KlornMac
```

On launch the pill appears at the top-center of your screen. Click it and choose
**Sign in with Google**: the OS browser handles OAuth (the server's desktop
nonce-poll flow), one consent also connects Gmail/Calendar, and the app stores
the JWT in the **Keychain**. The firewall then loads.

### First launch and the not-ready states

The first launch after install with no account opens a small **onboarding
window** instead of a logged-out full view: the logo, one sentence, the
sign-in buttons the server offers (Google always; Apple and Naver when
enabled), the five lanes with what each means, and what Klorn does with the
mail it reads. Signing in closes it and opens the full view, where the lane
guide and the mailbox question follow as before. It is the same for both
values of `macMainWindow`. A first launch that already has a token opens the
full view, and later launches open nothing.

Every mail surface (the bar's full view and expanded panel, the main
window) maps the model to one `SurfaceState`:

| State | Shows |
|-------|-------|
| signed out | "Sign in to Klorn", the sign-in buttons |
| signing in | "Finish signing in", *Start over* |
| loading | the "sorting every message into its lane" skeleton, and only here |
| offline (this Mac has no network, nothing loaded) | "You're offline", *Try again* |
| failed (a server error, a timeout, a TLS failure; nothing loaded) | "Couldn't load your mail", the reason, *Try again* |
| ready | the mail |

Loaded mail whose refresh is failing stays on screen under a banner
("You're offline. This is the mail from the last sync." or "Klorn couldn't
refresh…") with *Try again*. The pill's chip reads *Offline* only when the
network is the cause, *Not updating* otherwise, and a click retries (one
load at a time).

"Offline" is decided from the `URLError` code the API client now carries:
not connected, connection lost, host not found, DNS failure, data not
allowed, roaming off. A cancelled request is no error; everything else is
"Klorn can't reach its server". A failed action on one mail (pin, unpin,
dismiss, snooze) shows a short notice of its own and never raises the
refresh banner. Signing out drops the per-inbox queue snapshots.

### Keyboard

- **`⌥⌘K`** (Option-Command-K) — expand / collapse the bar from anywhere, even
  when another app is focused. It's a Carbon global hotkey, so it needs **no
  Accessibility permission** and never takes focus.
- **`⌘,`** — the Settings window (also the status-item *Preferences…* and the
  in-app Preferences buttons). Tabs: General, Accounts, Assistant,
  Notifications, Appearance, Privacy.

### Standard main window (beta, off by default)

Behind the `macMainWindow` user default (productization plan, macOS M2), the
full view opens as a standard titled window (traffic lights, resizable,
frame remembered across relaunch) instead of the bar's panel morphing into
it. The pill and the expanded panel are unchanged. While the window is open
Klorn is a regular app (Dock + Cmd+Tab + menus); closing it (⌘W, the red
button, or the header ✕) returns Klorn to ambient unless Settings is still
open. The header's *Smaller* closes the window and opens the expanded panel.
With the default off, nothing changes.

The window's content is the five-item navigation (M4b), not the bar's full
view: a sidebar with **Today · Mail · Calendar · Assistant** (Files joins
when a drive source exists), the connected accounts with a health dot, and
Settings at the foot.

- **Today** — mail by lane across the accounts (Push and Meeting expanded,
  Queue as a count plus its top five, Info as a count, Silent never), today's
  calendar, the briefing line and the approvals waiting. A row opens in Mail.
- **Mail** — the existing list and reader. Lanes are the primary filter
  (Push · Meeting · Queue (default) · Info · All; Silent only through
  *Show silenced* in the filter menu); folders and labels are sidebar facets.
- **Calendar** — the existing calendar at full width; team availability
  beside it while the server grants team mode.
- **Assistant** — the thread, with Approvals (the proposals list),
  Commitments and the Briefing beside it.

It is a custom two-column split, not `NavigationSplitView`: the window is an
AppKit `NSWindow` that owns its frame and restoration, the mail list keys
depend on the window's first responder, and the offscreen renderer cannot
draw AppKit-backed containers.

With the main window on, the composer and the modal cards are native too
(M5):

- **Compose** (`⌘N`, the Compose buttons, opening a draft) is its own
  window: titled, resizable, frame remembered. It covers nothing, so mail
  stays readable and every menu and list key keeps working behind it.
  `⌘N` on an open composer brings it forward. There is still one draft,
  owned by the model. Closing the window (`⌘W`, the red button) keeps the
  draft; *Discard Draft* clears it, asking first when there is something
  to lose; `⌘⏎` sends; the window will not close mid-send. Signing out, or
  switching the main window off, closes it. While it is open Klorn stays a regular app, like the main
  window. Message commands never act while the compose window is key.
- **The lane guide, the event editor and the connect-time question** are
  sheets on the main window (`NSWindow.beginSheet`), one at a time in the
  old overlays' order. A sheet blocks the list keys and every menu command
  exactly as the overlay did, and only while it is attached: a sheet asked
  for with the main window closed waits for the window and blocks nothing.

Signing out discards the compose draft (and forgets the Gmail draft it was
editing) in both modes, so the next account never inherits it.

Not in the composer because the model and `POST /api/email/send` carry only
to / subject / body: Cc, Bcc, attachments, recipient autocomplete, choosing
the sending account, and more than one draft at a time.

Turn it on with either:

- Settings ▸ General ▸ hold **Option** ▸ *Use standard main window (beta)*
  (the switch stays visible once on, so it can be turned back off), or
- `defaults write ai.klorn.desktop macMainWindow -bool YES` (packaged app;
  an unbundled `swift run` reads the `KlornMac` domain), then relaunch Klorn.

App menus (shown while Klorn is a regular app, i.e. a window is open):

| Menu | Item | Key |
|------|------|-----|
| File | New Email | `⌘N` |
| Edit | Search Mail | `⌘F` |
| Message | Reply with AI · Dismiss | `⌘R` · — |
| Message › Move to Lane | PUSH / MEETING / QUEUE / INFO / SILENT | `⌃⌘1`–`⌃⌘5` |
| Go | Inbox · Calendar · Proposals · Commitments · Waiting on | `⌘1`–`⌘5` |
| Go | Sent · Drafts · Archived · Teams (when granted) | — |

With `macMainWindow` on, Go is the sections instead: Today `⌘1`, Mail `⌘2`,
Calendar `⌘3`, Assistant `⌘4`, then Approvals `⌘5` and, without a key,
Commitments · Waiting on · Sent · Drafts · Archived · Teams (when granted).

In the main window the reading pane exists only in Mail, so the Message
items are off in Today, Calendar and Assistant, and leaving Mail drops the
open mail's selection.

Lane moves use `⌃⌘`, not bare digits: the reading pane binds bare `1`/`2`/`3`
to its quick replies, and `⌃1`–`⌃5` are macOS's "Switch to Desktop N".
Items disable when signed out or under a modal. Message items also need the
full view to be key — the bar's full panel, or the main window when
`macMainWindow` is on (not Settings) — and a selected message. While an inline
reply is open, Reply, Dismiss, Move to Lane, Go, and a mode-switching Search
stay disabled so the draft can't be lost. File ▸ New Email is the only `⌘N`.

Mail list keys (the full view's list in Inbox, a lane or a label; same in
the bar's full panel and the main window):

| Key | Action |
|-----|--------|
| `↑` / `↓`, `j` / `k` | Move the selection (opens the message like a click, scrolls it into view) |
| `Return` / `o` | Put the keyboard in the reading pane: arrows, Space and Page Up/Down scroll the message |
| `Esc` | Back to the list (from the reading pane or the search field) |
| `e` | Dismiss the selected message, then select the next one |
| `r` | Reply with AI (same as `⌘R`) |
| `/` | Search mail (same as `⌘F`) |
| `⌃⌘1`–`⌃⌘5` | Move to lane (the Message menu above) |

Bare keys never fire while a text field or editor has focus (search, inline
reply, compose, assistant), under a modal, or when the mail surface is not
the key window. `e` and `r` follow the Message menu's rules, and the
selection does not move while an inline reply is open. They also stand
down while a control holds keyboard focus (Tab / Full Keyboard Access on a
button, segmented control or popup): Return, Space and the arrows stay that
control's. In the reading pane only `Esc` is taken, so `r` there is `⌘R`;
bare `1`/`2`/`3` stay the quick replies. Known limit: with the caret in a
form field inside an email, `Esc` still returns to the list (the page's
editing state can't be read synchronously); letters typed there are never
taken, and an input method mid-composition keeps every key, `Esc` included.
The reading-pane zone is per window. On a non-Latin input source (Korean) the keys go by position. There
is no `z`/`⌘Z`: dismiss and lane moves have no undo path yet. The search
field no longer takes the keyboard when the full view first opens (it would
swallow every list key); `/` or `⌘F` puts it there.

### Row actions (on each PUSH item)

| Action | What it does |
|--------|--------------|
| **Open** | Opens that item in the web inbox (`item.href`, else `app.klorn.ai`). |
| **Snooze** (🌙) | Snoozes it to **9am tomorrow** (`POST /api/inbox/firewall/:id/snooze`); the server resurfaces it when the time passes. |
| **Dismiss** (✕) | Clears it from the queue (`POST /api/inbox/firewall/:id/dismiss`, status → DISMISSED). Leaves the email in Gmail — this is an attention action, not archiving. |

> **Reply** lives in the web app (via **Open**), on purpose: a compose field would
> need keyboard focus, which would break the bar's never-steal-focus promise.

## Real-time

New PUSH surfaces immediately, not on the next poll: the app connects to the API's
existing WebSocket hub (`wss://<api>/ws?type=desktop`, JWT offered via the
`klorn-ws-v1` Sec-WebSocket-Protocol subprotocol — never in the URL, so the
credential stays out of access logs) and refetches the firewall on a server
`notification`/`sync` event. A 60s poll stays as a backstop (reconnect gaps,
keep-warm). The connection forces TLS for any remote host so the token never
crosses plaintext.

## Notifications & the .app bundle

For each genuinely new PUSH the app can post an **OS notification** as a fallback
(e.g. when the bar isn't on your current Space). The first load is a silent
baseline, so an existing inbox doesn't spam you.

OS notifications need a bundle identifier, which an unbundled `swift run` lacks
(they're skipped cleanly there — the bar itself still works). Package a real,
double-clickable `Klorn.app` to get them:

```bash
scripts/make-app.sh                 # release build → Klorn.app, prod API baked in
open Klorn.app                      # or double-click in Finder
```

The prod API URL is written into `Info.plist` (`KlornAPIURL`), so a plain
double-click points at prod; `KLORN_API_URL` still overrides it. The bundle is
ad-hoc signed so macOS shows the notification-permission prompt. (A
*distributable* signed/notarized `.app` still needs full Xcode + a Developer ID.)

## Releasing (downloadable build)

`.github/workflows/desktop-release.yml` builds `Klorn.app` on a macOS runner and
publishes it as a **GitHub Release** asset. Cut one by pushing a tag:

```bash
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

The workflow runs with or without signing:

- **Ad-hoc** (no secrets, current state) — still publishes, but the build is
  ad-hoc signed, so a web download is quarantined and macOS shows
  **"Klorn.app is damaged."** Users must clear it once:
  `xattr -dr com.apple.quarantine /Applications/Klorn.app`. The release notes say so.
- **Notarized** (recommended for a public download) — with the six secrets below
  present the release is Developer-ID signed + Apple-notarized + stapled, so it
  opens with a plain double-click (no `xattr`).

### One-time notarization setup

Everything below is done by whoever owns the Apple Developer account (Team
`P89M32649C`). The CI is already wired — it only needs the secrets.

1. **Developer ID Application certificate** → export a `.p12`.
   Xcode › Settings › Accounts › your team › *Manage Certificates* › **+** ›
   *Developer ID Application*. Then in **Keychain Access**, right-click the new
   cert → *Export* → save `DeveloperID.p12` and set an export password.
2. **Base64 the cert** (this is the secret value, not the file):
   ```bash
   base64 -i DeveloperID.p12 | pbcopy   # → MACOS_DEVELOPER_ID_CERT_P12_BASE64
   ```
3. **Sign-identity string** — copy the full quoted name:
   ```bash
   security find-identity -v -p codesigning   # → "Developer ID Application: NAME (P89M32649C)"
   ```
4. **App-specific password for notarytool**: appleid.apple.com › *Sign-In and
   Security* › *App-Specific Passwords* › **+** → the generated `xxxx-xxxx-xxxx-xxxx`.
5. **Set the six repo secrets** (from the repo root, `gh` authenticated):
   ```bash
   base64 -i DeveloperID.p12 | gh secret set MACOS_DEVELOPER_ID_CERT_P12_BASE64
   gh secret set MACOS_DEVELOPER_ID_CERT_PASSWORD   # the .p12 export password
   gh secret set MACOS_SIGN_IDENTITY                # "Developer ID Application: NAME (P89M32649C)"
   gh secret set MACOS_NOTARY_APPLE_ID              # your Apple ID email
   gh secret set MACOS_NOTARY_TEAM_ID               # P89M32649C
   gh secret set MACOS_NOTARY_APP_PASSWORD          # the app-specific password from step 4
   ```
6. **Cut a notarized release** — push a *new* tag (releases are immutable, so bump
   rather than re-tag `desktop-v0.1.1`):
   ```bash
   git tag desktop-v0.1.2 && git push origin desktop-v0.1.2
   ```
   The workflow detects the cert, signs + notarizes + staples, and publishes the
   release. It becomes "Latest", so the landing "Download for Mac" button —
   which points at `releases/latest/download/Klorn.dmg` — serves it with no
   further change, and the download now opens on a plain double-click.

## Release assets — both are load-bearing

| Asset | Purpose |
|---|---|
| `Klorn.dmg` | The human install path. The landing links straight to it. |
| `Klorn-macos.zip` | The in-app update channel, nothing else. |

`SelfUpdate.releaseZipURL()` builds
`releases/download/desktop-v<version>/Klorn-macos.zip` from the version string,
and `--self-check` asserts that exact URL. **Renaming or dropping the zip
silently breaks in-app updates for every already-installed copy** — they fall
back to opening the release page. Keep both assets, with these names.

The DMG is not cosmetic. A quarantined app launched from wherever it was
downloaded runs from a read-only `AppTranslocation` mount, so
`SelfUpdate.installTarget()` finds neither `~/Applications/Klorn.app` nor
`/Applications/Klorn.app` and returns `nil` — updates then fail permanently for
that user. The Applications symlink in the DMG window is what gets people to
move the app first, which is the only thing that ends translocation.

Builds are universal (`arm64` + `x86_64`) via `KLORN_ARCHS`, so they run on Intel
Macs too; the workflow asserts both slices are present before publishing. Local
builds stay host-arch unless you set `KLORN_ARCHS="arm64 x86_64"` yourself.

## Tests

The Command Line Tools toolchain ships no XCTest/Testing, so the auth state
machine, JSON decoding, notification planning, dismiss math, real-time signal
parsing, and snooze-time logic are verified by a plain-Swift harness that runs
here:

```bash
swift run KlornMac --self-check    # exit 0 = all pass (33 checks)
```

A full XCTest suite can be added when building under Xcode/CI.

## Layout

| File | Role |
|------|------|
| `KlornApp.swift` | `@main` entry (+ `--self-check`); `.accessory` app, `AppDelegate` owns the model, top bar, and hotkey |
| `Shell/` | the SwiftUI shell (M4a split of the former `TopBar.swift`): `TopBarRoot.swift` (`BarState`, `TopBarActions`, `TopBarMetrics`, `TopBarRoot`), `FullView.swift` (`ListMode`, `FullView`, `FullViewModals`), `Sidebar.swift` (`FullSidebar`), `SidebarResize.swift` (section resize handle), `TeamsColumn.swift`; the main window (M4b): `MainNav.swift` (`NavSection`, `LaneFilter`, `NavRules`), `MainShell.swift`, `NavSidebar.swift` |
| `Today/` | the main window's home (M4b): `TodayRules.swift` (pure composition), `TodayScreen.swift`, `TodayPanels.swift` (calendar and assistant panels) |
| `Pill/` | `CollapsedPill.swift` (`CollapsedBar`), `ExpandedDashboard.swift` (`ExpandedPanel` and its columns), `BriefingCard.swift`, `AccountColumn.swift` |
| `Mail/` | `FullList.swift` (the list column, alone in its file), `MailRow.swift` (`FullRow`, `SearchHitRow`), `MailboxList.swift`, `WaitingOnList.swift`, `CommitmentsList.swift`, `ReadingPane.swift`, `Compose.swift` (`ComposePanel`), `MailSection.swift` (main window: lane bar + list + reader) |
| `Calendar/` | `CalendarScreen.swift`, `EventRows.swift` (upcoming rows, week chips, event popover), `CalendarSection.swift` (main window) |
| `Assistant/` | `AssistantDock.swift`, `AssistantThread.swift` (thread + `ChatBubble`), `AssistantSection.swift` (main window: panes + thread) |
| `Onboarding/` | first launch (M6): `OnboardingWindow.swift` (`OnboardingRules`, `OnboardingWindowController`), `OnboardingView.swift` (the window's content, `LaneExplainer`) |
| `Shared/` | `SurfaceState.swift` (M6: `SurfaceState`, `SurfaceStateRules`, `SurfaceStateView`, `ConnectionBanner`, `SignInButtons`, `SolidButtonStyle`); views used by more than one feature: `Controls.swift`, `TierMenus.swift` (`SnoozeMenu`, `TierMenu`), `LaneChip.swift` (lane, signal, reply-state and label chips), `AccountRows.swift` (account rows, diagnostics, update row), `SegmentedBar.swift` (filter tabs, `SourceBadge`) |
| `SettingsWindow.swift` | `Settings` scene root (`TabView`), tab grouping, `SettingsOpener` |
| `MainWindow.swift` | standard main window (M2, `macMainWindow`): `MainWindowController` (a lazily created AppKit `NSWindow`, never a SwiftUI scene; also attaches the sheets, M5), its rules, the Settings beta switch |
| `Mail/ComposeWindow.swift` | compose window (M5, same flag): `ComposeWindowRules`, `ComposeWindowController` (lazily created, driven by the model's `showCompose`) |
| `Shell/MainSheets.swift` | the main window's sheets (M5): `MainSheet`, `MainSheetRules`, the shared modal-card chrome (`modalCard`) |
| `AppCommands.swift` | app menus (`.commands`) and their pure enablement/shortcut rules |
| `ListKeys.swift` | mail list keyboard (M3): pure key rules, the window-scoped key catcher |
| `TopBarController.swift` | the floating non-activating `NSPanel`: top-center pin, expand/collapse, row actions |
| `HotKey.swift` | Carbon `RegisterEventHotKey` global shortcut (`⌥⌘K`) |
| `RealtimeClient.swift` | WebSocket wake channel (reuses the API's `/ws` hub) |
| `AppModel.swift` | `@MainActor @Observable` state (auth, queue, poll, snooze/dismiss) |
| `AuthFlow.swift` | nonce-poll sign-in — pure orchestration (injectable deps) + live wiring |
| `APIClient.swift` | async URLSession client, Bearer auth, GET/POST |
| `KeychainStore.swift` | JWT persistence (Keychain generic password) |
| `TokenStore.swift` | Token-store seam: Keychain for the app, in-memory for the offscreen harnesses |
| `Models.swift` | `Tier`, `FirewallItem`, `FirewallResponse` (+ `removingIDs`), auth DTOs |
| `Config.swift` | env-overridable API + web base URLs |
| `Notifications.swift` | pure PUSH-diff planner + `UNUserNotification` poster |
| `Theme.swift` | colors + tier badge (dark-panel tokens) |
| `SelfCheck.swift` | the runnable verification harness |

## Auth flow (reuses the existing server contract)

1. `GET /api/auth/desktop-nonce` → nonce
2. open `…/api/auth/google/login?source=desktop&nonce=` in the OS browser
3. poll `GET /api/auth/desktop-token/:nonce` → `pending` → `{ok, token}`

No in-app OAuth, no custom URL scheme — the same browser-bounce + nonce-poll the
Electron shell used, ported faithfully (and re-verified) to Swift.
