# desktop-mac Rebuild Blueprint — Ambient Interrupt HUD

> Status: DESIGN (not yet implemented). Author date: 2026-07-07.
> Grounded against current `apps/desktop-mac/Sources/KlornMac/*` (14 files, zero deps, macOS 14, swift-tools 6.0).

## 1. Why we are rewriting

The current app is a **destination-window app that steals focus** — the exact opposite
of what a mail firewall's UI should be, which is why it is unused:

- `KlornApp.swift` AppDelegate forces foreground + focus steal:
  `NSApp.setActivationPolicy(.regular)` + `NSApp.activate(ignoringOtherApps: true)`
  + `makeKeyAndOrderFront` (KlornApp.swift:26–29).
- `applicationShouldTerminateAfterLastWindowClosed = true` (KlornApp.swift:31–33)
  → closing the window kills the whole app. Cannot be "always present."
- Scene = `WindowGroup` 1040×720 main window + `MenuBarExtra(.menu)` dropdown
  (KlornApp.swift:43–56). A destination + a static dropdown. No ambient surface.
- Data = single `GET /api/inbox/firewall`, **60s poll only** (AppModel.swift:23,103–111).
  No server push → up to 60s latency on "something important arrived."
- No `NSStatusItem` / `NSPanel` / `nonactivating` / floating level anywhere (grep: 0).
- No VRM/3D avatar exists (grep: 0) — earlier memory note was aspirational, not code.

## 2. Target model (locked — corrected 2026-07-07 after watching the reference video)

> The desktop app is a **custom always-on top bar** pinned to the top-center of the
> screen (NOT the macOS system menu bar). It has two states:
> - **Collapsed**: a slim dark rounded pill — `☰ · Klorn logo · live state (PUSH count /
>   syncing / Log In)`. Always visible = glanceable + proof the firewall is running.
> - **Expanded**: clicking `☰` morphs the pill downward into a full panel (echoing the
>   reference video's 3-column mega-menu: `INBOX counts · RECENT PUSH · ACCOUNT`).
>   Clicking `— Close` collapses it back to the pill.
> Non-focus-stealing throughout (`.nonactivatingPanel`, `orderFrontRegardless`). New PUSH
> updates the always-visible count (+ optional OS-banner fallback); the user expands on
> demand. QUEUE/SILENT/AUTO never force anything. Full inbox still lives on web/mobile.

Reference video (`~/Desktop/화면 기록 2026-07-07…mov`): a centered dark pill navbar that
expands into a wide dark panel on `☰ Menu` and collapses on `— Close`. NOT a system
menu-bar dropdown, NOT a transient corner card — those were both wrong earlier reads.

### Non-negotiable constraints (violate one → we rebuild the flow-break we are killing)
1. **Never steal focus.** `NSPanel(.nonactivatingPanel)`, `level = .floating`,
   `becomesKeyOnlyIfNeeded`, `hidesOnDeactivate = false`. The user's active app stays active.
2. **Keyboard-completable.** Reaching the corner with a mouse is itself a context switch.
   Global hotkey to summon/dismiss/act; in-panel key handling for the action set.
3. **PUSH only.** QUEUE/SILENT/AUTO must never trigger the panel or a banner.
4. **Low frequency.** ~2–5 surfaces/day. The 4-tier classifier is what makes this
   affordable — this app exposes classifier quality directly (see §8 risk).

## 3. Architecture: keep the plumbing, rebuild the shell

```
                 ┌─────────────────────────── REBUILD (shell + UI) ───────────────────────────┐
  menu bar  ->   NSStatusItem  ─┐                                                               │
                                ├─>  HudController (NSPanel .nonactivating .floating)  <── new   │
  hotkey    ->   HotKey (Carbon)┘         │  hosts compact SwiftUI PushCard (NSHostingView)      │
                                          v                                                      │
                 ┌──────────────────────── KEEP (plumbing, ~unchanged) ─────────────────────────┤
  AppModel  ->   poll/SSE loop  ->  APIClient  ->  GET /api/inbox/firewall  ->  Models (DTO)     │
                      │                                                                          │
                      └─> planPushNotifications (pure diff)  -> new PUSH ids -> HudController     │
  auth      ->   AuthFlow (nonce -> browser -> token poll) -> KeychainStore                      │
```

## 4. File ledger — KEEP / MODIFY / DELETE / NEW (precise)

### KEEP as-is (plumbing — do NOT touch, do NOT rewrite)
| File | Reason |
|---|---|
| `APIClient.swift` | Dependency-free async URLSession client; transport unaffected by UI model |
| `Models.swift` | Codable DTOs (`Tier`, `FirewallItem`, `FirewallResponse`, nonce/token) are transport shape |
| `KeychainStore.swift` | JWT storage; orthogonal to window model |
| `AuthFlow.swift` | Pure sign-in state machine + `GoogleSignIn` OS-browser wiring; unit-tested |
| `Config.swift` | API base-URL resolution (env → Info.plist → localhost); orthogonal |
| `Log.swift` | `os.Logger` wrappers; keep |
| `Notifications.swift` → `planPushNotifications` | **Pure baseline/diff = exactly the "what's new PUSH" signal the HUD consumes.** Keep the function verbatim; only change its *consumer*. |

### MODIFY (keep logic, change lifecycle/wiring)
| File | Change |
|---|---|
| `AppModel.swift` | (a) Decouple lifecycle from window: today the load is driven by `RootView.task`/window-appear + sign-in; move to **app-launch owned** so it runs headless in the menu bar regardless of panel visibility. (b) On new PUSH ids from `planPushNotifications`, call `HudController.present(item)` instead of only posting a banner. (c) Add SSE consumer (see §6) alongside the 60s poll as fallback. |
| `Notifications.swift` → `PushNotifier.post` | Demote to **coexistence/fallback** channel (native banner when the app is backgrounded or panel suppressed). Not the primary surface anymore. |
| `SelfCheck.swift` | Keep the plain-Swift harness; retarget tests: drop queue-view assertions, add HudController state + hotkey-plan + SSE-reconnect logic tests. |

### DELETE (unnecessary for the target — this is the "필요 없는 코드" ledger)
| File / code | Why it must go |
|---|---|
| `KlornApp.swift` — `WindowGroup(...)` scene (KlornApp.swift:44–50) | Destination window is the anti-pattern; there is no main window in the target |
| `KlornApp.swift` — AppDelegate focus-steal (`.setActivationPolicy(.regular)`, `activate(ignoringOtherApps:true)`, `makeKeyAndOrderFront`, KlornApp.swift:26–29) | Directly causes the flow-break we are killing; invert to `.accessory` + no activation |
| `KlornApp.swift` — `applicationShouldTerminateAfterLastWindowClosed = true` (KlornApp.swift:31–33) | App must survive with no window open; delete (or return false) |
| `KlornApp.swift` — `MenuBarExtra(.menu)` + `MenuBarContent` (KlornApp.swift:52–77) | Replaced by a hand-rolled `NSStatusItem` (a `.menu`-style dropdown can't host the rich status/quick surface we want) |
| `RootView.swift` | Full-window SignIn↔Queue router; there is no full window |
| `DecisionQueueView.swift` | 1040×720 full 4-tier `List`/`Section` view; wrong shape and wrong scope (shows all tiers). The full inbox belongs on web/mobile |
| `Theme.swift` → `FirewallRow` | Full-width list-row layout; replaced by the compact `PushCard`. **Keep** `Theme` color tokens + `TierBadge` (reused inside PushCard) |
| `Klorn.app/` committed bundle (binary dated Jun 24) | Stale artifact; regenerated by `scripts/make-app.sh`. Remove from tree or rebuild; do not treat as source of truth |

### NEW (the shell + surface)
| New file | Responsibility |
|---|---|
| `App.swift` (replaces KlornApp `@main`) | `NSApplicationDelegate`-driven, `setActivationPolicy(.accessory)`, no `WindowGroup`. Owns lifetime. Keeps the `--self-check` branch from `Entry`. |
| `StatusItemController.swift` | `NSStatusItem` in the menu bar: icon reflects engine health (connected/syncing/last-sync), PUSH-unseen count badge; click → small menu: Sign in/out, Open web inbox, Preferences, Quit. |
| `HudController.swift` | `NSPanel` subclass (`styleMask:[.nonactivatingPanel]`, `level:.floating`, `hidesOnDeactivate:false`, `becomesKeyOnlyIfNeeded:true`). Positions top-right under the menu bar. `present(item)` / `dismiss()` / queue when multiple. Hosts `PushCard` via `NSHostingView`. |
| `PushCard.swift` | Compact SwiftUI card: sender (title) · subject · one-line `tierReason` ("why PUSH") · action row. Reuses `TierBadge` + `Theme` colors. |
| `HotKey.swift` | Carbon `RegisterEventHotKey` wrapper (dependency-free) for a global summon/dismiss chord; in-card key handling for the action set. |
| `SignInPanel.swift` (shrink of SignInView) | One-time sign-in as a small panel or a StatusItem menu action — not a full window. |

## 5. Panel & interaction spec

- **Position**: top-right corner, ~12pt inset, below the menu bar. Multiple PUSH → vertical stack or a "1 of N" pager; never more than one card focus at a time.
- **Appearance trigger**: a new PUSH id surfaced by `planPushNotifications`.
- **Action set (v1, keyboard-first)**:
  - `Return` / click **Open** → open the item on web inbox (deep link) in default browser; card dismisses.
  - `Esc` / **Dismiss** → mark seen locally, card slides out. (Does not change server state.)
  - `S` / **Snooze** → v2 (needs backend, see §7).
  - `R` / **Quick reply** → v2 (needs backend send).
- **Auto-dismiss**: optional timeout (e.g. 20s) → falls back to `PushNotifier` native banner so nothing is silently lost.
- **No focus theft ever**: opening the card must not deactivate the user's current app.

## 6. Trigger: 60s poll → server push (the hidden half)

Current: `AppModel` polls `GET /api/inbox/firewall` every 60s. For an interrupt HUD, up to
60s latency undercuts "something important *just* arrived," and polling is wasteful.

**Decision: SSE (server-sent events) over the existing REST API + Bearer token, primary;
60s poll retained as reconnect fallback.**
- Rationale: the backend already has real-time Gmail pub/sub sync; a per-client SSE stream
  (`GET /api/inbox/stream`, `text/event-stream`) pushing new PUSH item ids reuses that signal
  without standing up APNs infra. The app holds one long-lived connection; on event, fetch/patch
  the queue and run the same `planPushNotifications` diff.
- **APNs is deferred** (the "someday, once notarized + push-entitled" path): requires an Apple
  Developer push cert + entitlements the current ad-hoc SwiftPM `.app` doesn't have. Not v1.
- Fallback: if SSE drops, resume 60s poll and reconnect with backoff.

**Backend work required**: add `GET /api/inbox/stream` (SSE, auth via same Bearer JWT,
emits on new PUSH-tier decisions). Verify against existing sync/emit points before building.

## 7. Backend endpoints — verify before assuming (do NOT assume these exist)
- `GET /api/inbox/firewall` — **exists** (consumed today).
- Auth: `GET /api/auth/desktop-nonce`, `/api/auth/google/login?source=desktop`,
  `/api/auth/desktop-token/:nonce` — **exist**.
- `GET /api/inbox/stream` (SSE) — **NEW, must build** (§6).
- Quick-reply send / snooze / mark-seen — **must verify** which endpoints exist (compose/send
  likely exists; snooze may not). v1 avoids these by shipping only Open + local Dismiss.

## 8. Honest risk (single biggest)
Thinning the UI to a pure PUSH surface **removes the inbox-window buffer** — perceived value
becomes `PUSH precision × recall × surfacing latency`, exposed directly to the user's face.
Miss a PUSH → user silently loses trust. Over-fire → user quits. **PUSH classifier quality
IS this app's spec.** Ship this only in lockstep with the classifier's PUSH metrics; treat a
PUSH recall regression as a P0 for this app, not a background eval number.

## 9. Build order (phased, each independently shippable)
- **Phase 0 — Ambient shell.** Convert to `.accessory` + `NSStatusItem`; delete `WindowGroup`,
  focus-steal, quit-on-close; `AppModel` runs headless; keep 60s poll + native banner. *Proves
  the app can live in the menu bar and never steal focus.*
- **Phase 1 — HUD panel.** `HudController` + `PushCard`; new PUSH → corner panel; Open + Dismiss;
  Esc/Return handling; native banner becomes fallback. *Delivers the core value.*
- **Phase 2 — Real-time.** Backend `GET /api/inbox/stream` (SSE); `AppModel` consumes it, poll
  becomes fallback. *Removes latency; app feels alive.*
- **Phase 3 — In-panel actions + hotkey.** `HotKey.swift` global summon; Quick reply + Snooze
  (after backend endpoints confirmed/built).

## 10. Toolchain reality (unchanged, carry forward)
- Machine has **Command Line Tools only, no full Xcode** → `swift build`/`swift run` only,
  no `xcodebuild`/`.xcodeproj`, no XCTest → tests stay in `SelfCheck.swift` (`--self-check`).
- Run: `KLORN_API_URL=https://klorn-api.onrender.com swift run KlornMac`.
- Packaged `.app` via `scripts/make-app.sh` (ad-hoc codesign). Notarization/APNs = later, needs Xcode.
