# Klorn — native macOS app

A **real native macOS client** of the Klorn firewall (SwiftUI), not a webview
wrapper. It lives as a **custom always-on bar pinned to the top-center of your
screen** — a slim pill you can glance at, that expands into the full firewall on
demand. It never steals focus from whatever you're working in: the whole point
is to surface what matters without knocking you out of your flow.

This replaces the old Electron `packages/desktop` shell. It's a Swift Package
(text-based, reproducible, diffable) rather than an `.xcodeproj` — a deliberate
deviation from the repo's "TypeScript only" lock, chosen for a genuinely native
app (`@klorn/core` stays the moat, served to every surface via the API).

## What it looks like

- **Collapsed** — a dark rounded pill at the top-center: `☰ · Klorn · live state`
  (PUSH count when signed in, `Log In` when not). Always visible, always
  glanceable. No Dock icon, no system-menu-bar item (it's an `.accessory` app).
- **Expanded** — click `☰` (or press `⌥⌘K`) and the pill morphs down into a
  3-column panel:
  - **INBOX** — the four tier counts (PUSH / QUEUE / SILENT / AUTO), click to open the web inbox.
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
existing WebSocket hub (`wss://<api>/ws?token=<JWT>&type=desktop`) and refetches
the firewall on a server `notification`/`sync` event. A 60s poll stays as a
backstop (reconnect gaps, keep-warm). The connection forces TLS for any remote
host so the token never crosses plaintext.

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

- **Notarized** (recommended for a public download) — add these repo Secrets and
  the release opens with a plain double-click:
  `MACOS_DEVELOPER_ID_CERT_P12_BASE64`, `MACOS_DEVELOPER_ID_CERT_PASSWORD`,
  `MACOS_SIGN_IDENTITY` (`Developer ID Application: … (P89M32649C)`),
  `MACOS_NOTARY_APPLE_ID`, `MACOS_NOTARY_TEAM_ID` (`P89M32649C`),
  `MACOS_NOTARY_APP_PASSWORD` (an app-specific password).
- **Ad-hoc** (no secrets) — still publishes, but Gatekeeper needs a one-time
  right-click → **Open**. The release notes say so.

Once the first release exists, point the landing page's "Mac app" button at
`https://github.com/k08200/klorn/releases/latest` instead of the source tree.

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
