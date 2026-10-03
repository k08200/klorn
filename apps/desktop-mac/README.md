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

Lane moves use `⌃⌘`, not bare digits: the reading pane binds bare `1`/`2`/`3`
to its quick replies, and `⌃1`–`⌃5` are macOS's "Switch to Desktop N".
Items disable when signed out or under a modal. Message items also need the
full view to be key — the bar's full panel, or the main window when
`macMainWindow` is on (not Settings) — and a selected message. While an inline
reply is open, Reply, Dismiss, Move to Lane, Go, and a mode-switching Search
stay disabled so the draft can't be lost. File ▸ New Email is the only `⌘N`.

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
| `TopBar.swift` | SwiftUI `CollapsedBar` (pill) + `ExpandedPanel` (3 columns) |
| `SettingsWindow.swift` | `Settings` scene root (`TabView`), tab grouping, `SettingsOpener` |
| `MainWindow.swift` | standard main window (M2, `macMainWindow`): `MainWindowController` (a lazily created AppKit `NSWindow`, never a SwiftUI scene), its rules, the Settings beta switch |
| `AppCommands.swift` | app menus (`.commands`) and their pure enablement/shortcut rules |
| `TopBarController.swift` | the floating non-activating `NSPanel`: top-center pin, expand/collapse, row actions |
| `HotKey.swift` | Carbon `RegisterEventHotKey` global shortcut (`⌥⌘K`) |
| `RealtimeClient.swift` | WebSocket wake channel (reuses the API's `/ws` hub) |
| `AppModel.swift` | `@MainActor @Observable` state (auth, queue, poll, snooze/dismiss) |
| `AuthFlow.swift` | nonce-poll sign-in — pure orchestration (injectable deps) + live wiring |
| `APIClient.swift` | async URLSession client, Bearer auth, GET/POST |
| `KeychainStore.swift` | JWT persistence (Keychain generic password) |
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
