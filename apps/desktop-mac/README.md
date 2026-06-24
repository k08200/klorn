# Klorn — native macOS app

A **real native macOS client** of the Klorn firewall (SwiftUI), not a webview
wrapper. It signs in natively and renders the 4-tier decision queue
(PUSH / QUEUE / SILENT / AUTO) the API classifies.

This replaces the old Electron `packages/desktop` shell. It's a Swift Package
(text-based, reproducible, diffable) rather than an `.xcodeproj` — a deliberate
deviation from the repo's "TypeScript only" lock, chosen for a genuinely native
app (`@klorn/core` stays the moat, served to every surface via the API).

## Run

The app talks to the Klorn API. Point it at local dev or prod:

```bash
# against local dev (api on :3001 — the default)
swift run KlornMac

# against prod (the API host — NOT app.klorn.ai, which only serves the web UI)
KLORN_API_URL=https://klorn-api.onrender.com swift run KlornMac
```

Sign in with **Sign in with Google**: the OS browser handles OAuth (the
server's desktop nonce-poll flow), one consent also connects Gmail/Calendar, and
the app stores the JWT in the **Keychain**. The decision queue loads on return.

## Notifications & the .app bundle

The app polls the queue every 60s and posts an **OS notification for each new
PUSH item** — the firewall's whole promise (interrupt only for what's new and
loud). The first load is a silent baseline, so an existing inbox doesn't spam you.

OS notifications need a bundle identifier, which an unbundled `swift run` lacks
(they're skipped cleanly there — the app still works). Package a real, double-
clickable `Klorn.app` to get them:

```bash
scripts/make-app.sh                 # release build → Klorn.app, prod API baked in
open Klorn.app                      # or double-click in Finder
```

The prod API URL is written into `Info.plist` (`KlornAPIURL`), so a plain
double-click points at prod; `KLORN_API_URL` still overrides it. The bundle is
ad-hoc signed so macOS shows the notification-permission prompt. (A *distributable*
signed/notarized `.app` still needs full Xcode + a Developer ID.)

## Tests

The Command Line Tools toolchain ships no XCTest/Testing, so the auth state
machine and JSON decoding are verified by a plain-Swift harness that runs here:

```bash
swift run KlornMac --self-check    # exit 0 = all pass
```

These mirror the TS `desktop-login.ts` unit tests one-for-one. A full XCTest
suite can be added when building under Xcode/CI.

## Layout

| File | Role |
|------|------|
| `KlornApp.swift` | `@main` entry (+ `--self-check`), window + menu-bar scenes |
| `AppModel.swift` | `@MainActor @Observable` app state (auth phase, queue) |
| `AuthFlow.swift` | nonce-poll sign-in — pure orchestration (injectable deps) + live wiring |
| `APIClient.swift` | async URLSession client, Bearer auth |
| `KeychainStore.swift` | JWT persistence (Keychain generic password) |
| `Models.swift` | `Tier`, `FirewallItem`, `FirewallResponse`, auth DTOs (Codable) |
| `Config.swift` | env-overridable API base URL |
| `RootView` · `SignInView` · `DecisionQueueView` · `Theme` | SwiftUI UI |
| `SelfCheck.swift` | the runnable verification harness |

## Auth flow (reuses the existing server contract)

1. `GET /api/auth/desktop-nonce` → nonce
2. open `…/api/auth/google/login?source=desktop&nonce=` in the OS browser
3. poll `GET /api/auth/desktop-token/:nonce` → `pending` → `{ok, token}`

No in-app OAuth, no custom URL scheme — the same browser-bounce + nonce-poll the
Electron shell used, ported faithfully (and re-verified) to Swift.
