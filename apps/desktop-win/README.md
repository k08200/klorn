# Klorn for Windows

A deliberately thin Tauri v2 shell around the hosted web app. The window IS
app.klorn.ai; the shell adds exactly these things:

- **single instance** — a second launch shows and focuses the first window
- **the opener plugin** — so the web app can hand Google OAuth to the SYSTEM
  browser (Google rejects OAuth inside embedded webviews, RFC 8252)
- **OS banners** for PUSH-lane mail and meetings starting soon (parity with
  the Mac app, founder decision 2026-10-15) — one shell command,
  `show_banner` (`src/banner.rs`), backed by the notification plugin
- **close-to-tray** — closing the window hides it; the tray icon's
  *Open Klorn* / *Quit Klorn* (Korean on a Korean-locale Windows) bring it back
  or quit for real.
- **start at sign-in, opt-in** — `tauri-plugin-autostart` (`src/autostart.rs`).
  OFF until the user accepts the web app's one-time prompt or turns it on in
  Settings → Notifications; see *Start at sign-in* below.
- **theme-matched window background** — `#0A0A0B` on a dark OS, white on a
  light one, so the frame does not flash before the page paints

The web app detects this shell through the IPC global Tauri injects
(`window.__TAURI_INTERNALS__`) — see `packages/web/src/lib/native/shell.ts` —
and takes its PKCE poll login flow. The deep-link relay flow stays
Capacitor-only.

## How banners work

WebView2 has no dependable Web Push, so the shell does not use it. The web
app's bell already receives every real-time `notification` frame over its
websocket. The server tags a frame `alert: "push"` (PUSH-lane mail, including
the urgent sweep that shares its bell row) or `alert: "meeting"` (meeting
starting soon) — and only when the user's notification preferences and quiet
hours allow that category, the same gate Web Push uses
(`packages/api/src/notify/desktop-alert.ts`). Inside the shell the bell hands
frames to `packages/web/src/lib/native/tauri-notify.ts`, which banners tagged
frames once per notification id by invoking the shell's `show_banner` command.
Untagged frames (QUEUE / INFO / SILENT, agent notes, briefings) never banner;
an untagged PUSH / meeting frame (the gate said no) is recorded as seen so it
can never banner later.

The ids live in a per-account ledger — in memory for the session, persisted
to `localStorage` (`klorn.desktopAlerts.ledger:<userId>`: the user id plus
opaque notification ids, no mail content) — so they survive a restart.

The plugin replaces `window.Notification` in the webview, so the bell's
generic browser-notification path is skipped inside Tauri — otherwise every
frame would become a toast.

Clicking a banner: the plugin has no click callback on Windows. For the
installed app the toast carries its AppUserModelID, and Windows activates the
app on click, which lands in the single-instance handler and shows the window.
That path is expected, not yet verified on a Windows machine.

Real-time banners only arrive while Klorn is running (window open or in the
tray) and its websocket is connected; there is no server push to a quit app,
and the API keeps no replay of frames sent while the socket was down.

### Catch-up after quit, restart or sleep

Every bell refetch — on start, on socket reconnect, on focus / network return,
and the 60 s poll — also runs a catch-up pass
(`packages/web/src/lib/native/desktop-catchup.ts`, mirroring the Mac app's
`PushLedger`):

- **source: the bell's own rows**, not the PUSH/MEETING lanes. The
  `"Urgent email"` row is written only when the server decided to interrupt
  for a PUSH- or MEETING-lane mail (after its recency, dedupe and interrupt
  budget gates), and its id is the id the live frame carries — one ledger, so
  live and catch-up never banner the same mail twice. A lane also holds mail
  the server deliberately never pushed. `type: "meeting"` rows are the
  meeting-starting-soon reminders.
- **silent baseline** on the first pass for an account, so a first launch
  (or a new account signing in) never dumps old mail; each account keeps its
  own ledger;
- **each id once**, across restarts;
- **at most 5 banners per pass, newest first** — the rest are recorded
  silently;
- **fresh only**: PUSH rows older than 24 h, meeting reminders older than
  2 minutes (they are written 1–5 minutes before the start, so later the
  meeting may be under way), and rows already read on another device are
  recorded without a banner; rows younger than 30 s are left to their live
  frame.

**Preference-gate gap.** Bell rows do not record whether the server's gate
allowed a banner, and the API has no alert-state endpoint yet. Catch-up
honours the category opt-outs (`notifyEmailUrgent` / `notifyMeeting` from
`GET /api/automations`, fetched only when a pass has something to banner) but
does **not** re-evaluate quiet hours or focus windows — that logic stays on the
server. So a PUSH mail missed while Klorn was quit can banner on return even
if it arrived inside quiet hours, or banner during quiet hours if Klorn starts
then. Mail that arrives while Klorn is running is unaffected: its frame is
gated live. When the server exposes its gate decision, catch-up should use it.

## Start at sign-in

Opt-in, like the Mac's login item; the shell never enables it on its own.

- `tauri-plugin-autostart` writes a `Run` registry entry when the user says
  yes and removes it when they turn it off. The plugin uses `auto-launch`'s
  default *Dynamic* mode: per-user (`HKCU`) when Klorn runs unelevated, as the
  per-user NSIS install does; it would write the machine-wide (`HKLM`) entry
  only if Klorn itself ran as administrator.
- One-time prompt (`packages/web/src/components/autostart-prompt.tsx`, rules
  in `lib/native/autostart-prompt.ts`): shown once after sign-in, only inside
  this shell, only while start-at-sign-in is off. The answer is kept in
  `localStorage` (`klorn.desktopAutostart.promptAnswer`) and never asked again;
  a failed enable shows an error toast instead of re-asking.
- Setting: Settings → Notifications → *Start at sign-in*
  (`app/settings/_sections/launch-at-login-row.tsx`), rendered only in this
  shell.
- A sign-in launch carries `--autostart` and starts in the tray with the window
  hidden; the webview still loads the app and connects, as after
  close-to-tray. *Open Klorn* in the tray, or launching Klorn again, shows it.
  Not verified on Windows yet: whether a hidden window loads the app when the
  network is not up at sign-in (the service worker's cached shell should
  serve the navigation, and the bell reconciles on `online`), and what the
  user sees if the session has expired (a hidden `/login` — no banners until
  they open Klorn).

## Security: what the remote origin may call

The whole UI is a remote origin, so `capabilities/default.json` exposes the
IPC bridge to `https://app.klorn.ai` via `remote.urls`. Tauri expands that to
exactly that host, https only, any path — no subdomains, no http. The grant is
least privilege:

| Permission | Why |
|---|---|
| `opener:allow-open-url` scoped to `https://**`, `mailto:*` | OAuth in the system browser |
| `allow-show-banner` (the app's own command, `src/banner.rs`) | post a banner: title + body only, control characters removed, clamped to 120 / 240 characters in Rust; permission checked in Rust |
| `autostart:allow-enable`, `allow-disable`, `allow-is-enabled` | start at sign-in. No command takes an argument: the `Run` entry's program path and `--autostart` are fixed in `src/autostart.rs` |
| `core:app/event/path/webview/window:default` | `core:default` spelled out minus `core:tray`, `core:menu`, `core:image`, `core:resources` |

Why `core:default` is spelled out: enabling the `tray-icon` feature compiles
the tray commands, and `core:default` would then let the page create, replace
or hide tray icons and menus, and `core:image` can load an image from a path.
None of that is needed by the web app, so it is not granted.

No notification-plugin command is granted. Its `notify` takes the whole
NotificationData — icon path, attachments, schedule, sound — and on Windows an
icon becomes a `file:///` toast image source, so a compromised page could
point it at a UNC path. `show_banner` fixes everything but the text.

No shell, fs, http, process or window-mutating permission is granted. A
compromised page (XSS on app.klorn.ai) could at worst open a browser tab,
post a toast, or switch Klorn's own start-at-sign-in on or off — it cannot
choose what Windows runs. The only custom IPC input is `show_banner`'s two
strings, sanitized in Rust (and already validated and capped by
`desktop-alerts.ts` on the web side).

## Build

```
cd apps/desktop-win/src-tauri
cargo check          # compiles on any OS
cargo test           # banner sanitizing, tray labels, theme colour, sign-in launch flag
cargo tauri build    # NSIS installer, Windows only
```

`icons/icon.ico` is a PNG-embedded multi-size .ico built from the brand mark
(`cargo tauri icon`). The tray uses the same window icon.

## Not yet wired

- ~~Windows release workflow~~ → `.github/workflows/desktop-win-release.yml`, tag `desktop-win-v*`
- Code signing (separate founder decision; SmartScreen warns until then).
- In-app updater (the web content is live; only shell changes need a reinstall).
- Quiet hours / focus windows for catch-up banners — needs the server to expose
  its gate decision (see *Preference-gate gap* above).
- The landing's Windows card still points at the web app until an installer
  exists — flip `data-win-href` only after the first release is live.
