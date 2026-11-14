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

**Toast content (decision N1).** A frame about one mail carries `mail`
(`{ emailId, title, body }`, the same shape as the device push): the toast's
title is the sender, its body the subject plus the judge's reason on a second
line. Other frames keep their own title and message.

**Clicking a banner (decision N1).** `show_banner` also takes `open`, the
in-app page a click opens — accepted only as `/today` or `/email/<id>` (uuid /
cuid characters), checked again in Rust.

On Windows the shell posts the toast itself (WinRT, `banner.rs`
`post_protocol_toast`) with `activationType="protocol"` and a launch URI
`klorn://toast?open=<page>&receipt=<row id>` (`src/toast_link.rs`). A click —
on the toast on screen **or in the Action Center**, with Klorn running or quit
— makes Windows launch `Klorn.exe "<uri>"` through the `klorn` scheme the
installer registers (`tauri.conf.json` → `plugins.deep-link.desktop.schemes`;
Tauri's NSIS template writes `HKCU\Software\Classes\klorn` on install and
removes it on uninstall). Running: the single-instance plugin hands the URI to
the running copy, which shows, un-minimizes and focuses the window, reports
the receipt and opens the page through the web app's router
(`components/desktop-toast-router.tsx`, `window.__klornOpenToast`), or a plain
navigation when the router is not mounted yet. Quit: Klorn starts with the URI,
loads the page instead of the sign-in page, and reports the receipt once that
page has loaded and the web app installed its click hook (polled for ~10 s).

Why not the notification plugin: tauri-plugin-notification 2.7 reports a
click only **while the toast is on screen** (its `NotificationBuilder::show`
docs; its notify-rust wait thread takes one event per toast and ends when the
toast times out into the Action Center). Klorn is an unpackaged app and the
installer registers no COM activator (`ToastActivatorCLSID`), so Windows has
no in-process callback for an Action Center click; protocol activation is
what it supports for such apps. The plugin still posts the toast (on-screen
clicks only, `banner::on_action`) when the shell's own WinRT post fails, and
in non-Windows dev builds.

Limits: a `cargo tauri dev` / `cargo build` run has no `klorn` scheme
registered and posts under PowerShell's AppUserModelID, so a click there opens
nothing; an installed shell built before this change keeps the old on-screen
only behaviour until it is reinstalled. Not yet verified on a Windows machine
beyond the release workflow's smoke test (scheme registered, a `klorn://`
launch reaches the running copy and shows its window).

**Receipts.** The web app reports what became of a toast to
`POST /api/notifications/desktop/receipts`
(`packages/web/src/lib/native/desktop-receipts.ts`), keyed on the bell row id
(`kind: "notification"`): `shown` when `show_banner` posted it (`true`; a
shell built before receipts answers nothing for a posted toast, `false` means
the OS refused permission), `clicked` when a click reaches the shell (from
the Action Center too, see above) — the page passed the row id as `receipt`,
Rust checks it is a uuid, carries it in the launch URI and hands it back
through `window.__klornToastClicked` (installed by
`desktop-toast-router.tsx`). The catch-up summary stands for several rows and
reports nothing. Fire-and-forget: one request at a time, at most 30 a minute
(the server allows 60 per user), a network error or 5xx retried after 2 s and
10 s and then dropped, a 4xx never retried, a 429 pauses the queue a minute.
`shown` works with any installed shell (an older shell answers nothing even
when the OS refused permission, which desktop Windows does not do); `clicked`
from the Action Center needs a shell built with protocol activation, and a
click on a running Klorn is not reported while the page's router is not
mounted (the same case in which a click falls back to a plain navigation).

**No Reply / Later buttons.** A protocol launch carries the toast's one URI,
and buttons posted through the plugin would only work while the toast is on
screen: from the Action Center they would silently do nothing, and Later
would then never set its reminder. Reply / Later stay on the phone, Web Push
and in-app.

Real-time banners only arrive while Klorn is running (window open or in the
tray) and its websocket is connected; there is no server push to a quit app,
and the API keeps no replay of frames sent while the socket was down.

### Catch-up after quit, restart or sleep

Every bell refetch — on start, on socket reconnect, on focus / network return,
and the 60 s poll — also runs a catch-up pass. Common rules (mirroring the Mac
app's `PushLedger`):

- **source: the bell's own rows**, not the PUSH/MEETING lanes. The urgent-mail
  row is written only when the server decided to interrupt for a mail (after
  its recency, dedupe and interrupt-budget gates), and its id is the id the
  live frame carries — one ledger, so live and catch-up never banner the same
  mail twice. `type: "meeting"` rows are the meeting-starting-soon reminders.
- **silent baseline** on the first pass for an account, so a first launch
  (or a new account signing in) never dumps old mail; each account keeps its
  own ledger;
- **each id once**, across restarts; rows younger than 30 s are left to their
  live frame;
- **each mail once**: a mail toast also records `mail:<emailId>`, so a second
  bell row for the same mail (the urgent sweep re-rings unread mail once
  "Clear all" deleted the rows its dedupe reads) neither toasts live nor is
  caught up — the Mac keys its ledger on the mail's attention item the same
  way.

**Urgent mail (decision N6,
`packages/web/src/lib/native/desktop-push-catchup.ts`).** For unseen,
unread urgent-mail rows from the last 72 h that name one mail
(`sourceEmailId`, written by the firewall push and by a one-mail urgent
sweep), the shell asks `GET /api/notifications/desktop-catchup?ids=…`
(`packages/api/src/notify/desktop-catchup.ts`). The server keeps only mails
that are still an OPEN PUSH item and not read in the mailbox (read in Gmail,
or bulk-marked read in Klorn, which leaves the bell row unread — as on the
Mac), shapes each like every mail notification
(N1, in the user's notification language) and applies the live frame's gate:

- **exactly one** missed mail → that mail's normal toast, opening it;
- **two or more** → one summary toast, "N urgent emails while Klorn was
  closed", body "Sender1, Sender2, Sender3 +k", opening Today;
- **quiet hours** → `held`: nothing is shown or recorded, and the shell asks
  again at most every 5 minutes, so the toast comes after quiet hours end;
- urgent-mail alerts turned off → nothing.

Not caught up: rows written before this change and urgent-sweep rows that
batch several mails (neither names one mail). Quiet hours while Klorn is
**running** follow the live gate instead: the frame arrives untagged, is
recorded, and never toasts later — the same as Web Push, which drops (does not
defer) an alert during quiet hours. Only mail missed while Klorn was closed or
asleep is held until quiet hours end.

**Meetings (`desktop-catchup.ts`).** At most 5 banners per pass, newest
first; reminders older than 2 minutes (they are written 1–5 minutes before the
start, so later the meeting may be under way) and rows already read on another
device are recorded without a banner. Category opt-outs come from
`GET /api/automations`; quiet hours are not re-evaluated for meetings.

## Start at sign-in

Opt-in, like the Mac's login item; the shell never enables it on its own.

- `tauri-plugin-autostart` writes a `Run` registry entry when the user says
  yes and removes it when they turn it off. The plugin uses `auto-launch`'s
  default *Dynamic* mode: per-user (`HKCU`) when Klorn runs unelevated, as the
  per-user NSIS install does; it would write the machine-wide (`HKLM`) entry
  only if Klorn itself ran as administrator.
- One-time prompt (decision N5, `packages/web/src/components/autostart-prompt.tsx`,
  rules in `lib/native/autostart-prompt.ts`): a modal "Keep Klorn running in
  the background?" with *Not now* and *Open at login* (the primary, initially
  focused button; Esc = *Not now*), shown once after sign-in, only inside
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
| `allow-show-banner` (the app's own command, `src/banner.rs`) | post a banner: title + body (control characters removed except one line break in the body, clamped to 120 / 240 characters in Rust) the page a click opens (`/today` or `/email/<id>` only, checked in Rust) and the bell row id a click's receipt names (a uuid only, checked in Rust); permission checked in Rust |
| `autostart:allow-enable`, `allow-disable`, `allow-is-enabled` | start at sign-in. No command takes an argument: the `Run` entry's program path and `--autostart` are fixed in `src/autostart.rs` |
| `core:app/event/path/webview/window:default` | `core:default` spelled out minus `core:tray`, `core:menu`, `core:image`, `core:resources` |

Why `core:default` is spelled out: enabling the `tray-icon` feature compiles
the tray commands, and `core:default` would then let the page create, replace
or hide tray icons and menus, and `core:image` can load an image from a path.
None of that is needed by the web app, so it is not granted.

No notification-plugin command is granted. Its `notify` takes the whole
NotificationData — icon path, attachments, schedule, sound — and on Windows an
icon becomes a `file:///` toast image source, so a compromised page could
point it at a UNC path. `show_banner` fixes everything but the text and the
in-app page a click opens.

No shell, fs, http, process or window-mutating permission is granted. A
compromised page (XSS on app.klorn.ai) could at worst open a browser tab,
post a toast, or switch Klorn's own start-at-sign-in on or off — it cannot
choose what Windows runs. The only custom IPC input is `show_banner`'s
strings, sanitized in Rust (and already validated and capped by
`desktop-alerts.ts` on the web side); `open` can only name Today or one mail
on app.klorn.ai, and `receipt` only a uuid (hex digits and dashes), so the
click script it is spliced into cannot be broken out of.

The `klorn://` scheme is reachable from outside too: any web page can open a
`klorn://toast?…` link once the browser's own "Open Klorn?" prompt is
accepted. Such a link gets exactly what a toast click gets, through the same
checks (`toast_link::parse`): the window is shown, Today or one mail by id is
opened, and `clicked` is reported for a bell row id — which the receipts
endpoint accepts only for the caller's own rows and stamps on the first report
only. Anything else in the link is dropped.

## Build

```
cd apps/desktop-win/src-tauri
cargo check          # compiles on any OS
cargo test           # banner sanitizing, toast XML, click routes and receipt ids, klorn:// links, tray labels, theme colour, sign-in launch flag
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
