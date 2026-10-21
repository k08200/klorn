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
  or quit for real. Start-at-login is not implemented.
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
frames once per notification id (ids kept in `sessionStorage`) by invoking
the shell's `show_banner` command. Untagged frames (QUEUE / INFO / SILENT, agent
notes, briefings) never banner.

The plugin replaces `window.Notification` in the webview, so the bell's
generic browser-notification path is skipped inside Tauri — otherwise every
frame would become a toast.

Clicking a banner: the plugin has no click callback on Windows. For the
installed app the toast carries its AppUserModelID, and Windows activates the
app on click, which lands in the single-instance handler and shows the window.
That path is expected, not yet verified on a Windows machine.

Banners only arrive while Klorn is running (window open or in the tray) and
its websocket is connected; there is no server push to a quit app.

## Security: what the remote origin may call

The whole UI is a remote origin, so `capabilities/default.json` exposes the
IPC bridge to `https://app.klorn.ai` via `remote.urls`. Tauri expands that to
exactly that host, https only, any path — no subdomains, no http. The grant is
least privilege:

| Permission | Why |
|---|---|
| `opener:allow-open-url` scoped to `https://**`, `mailto:*` | OAuth in the system browser |
| `allow-show-banner` (the app's own command, `src/banner.rs`) | post a banner: title + body only, control characters removed, clamped to 120 / 240 characters in Rust; permission checked in Rust |
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
compromised page (XSS on app.klorn.ai) could at worst open a browser tab or
post a toast — the same power it already has in a normal browser tab. The
only custom IPC input is `show_banner`'s two strings, sanitized in Rust
(and already validated and capped by `desktop-alerts.ts` on the web side).

## Build

```
cd apps/desktop-win/src-tauri
cargo check          # compiles on any OS
cargo test           # banner sanitizing, tray labels, theme colour
cargo tauri build    # NSIS installer, Windows only
```

`icons/icon.ico` is a PNG-embedded multi-size .ico built from the brand mark
(`cargo tauri icon`). The tray uses the same window icon.

## Not yet wired

- ~~Windows release workflow~~ → `.github/workflows/desktop-win-release.yml`, tag `desktop-win-v*`
- Code signing (separate founder decision; SmartScreen warns until then).
- In-app updater (the web content is live; only shell changes need a reinstall).
- The landing's Windows card still points at the web app until an installer
  exists — flip `data-win-href` only after the first release is live.
