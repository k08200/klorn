# Klorn Mobile (bundled app)

Native Android + iOS app for Klorn: a **React 19 + TypeScript + Vite SPA bundled
into the binary** (`src/`), inside a **Capacitor 8** shell (`appId ai.klorn.app`,
committed `android/` and `ios/` projects). It talks to the Klorn API directly —
it no longer loads `app.klorn.ai` in a WebView. Only Klorn's colour/type tokens
are shared with the web (`src/styles/tokens.css` mirrors
`packages/web/src/app/globals.css`).

> **Standalone package** — NOT in the pnpm workspace. Use **npm** here (like
> `apps/desktop-mac`). Wire types come from `packages/contract` through a
> tsconfig path alias, as `import type` only (pinned by `src/config.test.ts`).

> **Status (2026-10-16).** Shell at every size class, auth, data layer,
> offline cache, i18n, Today, **Mail** (list, swipe rows, lane sheet, reader,
> reply / compose with an explicit confirm, Later, Subscriptions), Calendar,
> Assistant (chat / Approvals / Activity), Files, Accounts & sources, Settings,
> push (priming, registration, tap routing, iOS action categories,
> Android action buttons for data-only messages), in-app
> purchase (RevenueCat) and self-service account deletion are built. Store
> builds still need the device / CI checks listed below (see
> `STORE_SUBMISSION.md`).

## Commands

```bash
cd apps/mobile
npm ci
npm run dev          # Vite dev server against http://localhost:3001 (local API)
npm run dev:mock     # Vite dev server against the in-app mock API (fixtures)
npm run typecheck
npm test             # vitest: router, size classes, API client, i18n parity, Today + Mail models,
                     #   swipe thresholds, undo window, lane sheet, snooze, mail HTML sanitizer (XSS),
                     #   calendar / assistant / files / accounts models, push routing,
                     #   Android data-only notifications, on-demand locale catalogs
npm run lint         # biome with the repo-root biome.json, errors only
npm run build        # typecheck + vite build → dist/ (what Capacitor bundles)
npm run e2e          # Playwright screenshots + behaviour against the mock build
npm run sync         # build + `cap sync` (copies dist/ into android/ and ios/)
npm run open:android # / open:ios — then Run in Android Studio / Xcode
```

API base: `VITE_KLORN_API_URL` at build time (https only, or http to
localhost / `10.0.2.2` for the Android emulator); unset → dev
`http://localhost:3001`, production build `https://klorn-api.onrender.com` (the
origin the web app and the Mac app ship with; `api.klorn.ai` is a CNAME to the
same Render service).

Screenshots: `KLORN_SHOTS_DIR=/some/dir npm run e2e` (default
`test-results/shots`). Specs cover 390×844, 412×915, 360×400 (Flip cover),
884×1104 (Fold flat, with an emulated vertical hinge, and half-folded
tabletop), 744×1133, 1024×1366 and 1366×1024, light and dark, plus Welcome and
the loading / empty / error / no-account / offline states. The hinge is
emulated with Chromium's display-feature override, so the real Viewport
Segments API is exercised. Mock builds accept `?insets=top,right,bottom,left`
to fake safe areas, `?scenario=` to pick a fixture set
(`src/api/mock/transport.ts`; `sendReceipts` = the server's send receipts on),
`?iap=ios|android` to fake a store offer on Plans (`src/platform/iap.ts`) and
`?signup=closed` for invite-only sign-up. `@playwright/test` is pinned to the Chromium
revision preinstalled in our images — never run `playwright install` there.

Every screenshot goes through `snap()` (`e2e/helpers.ts`), which waits on a
deterministic signal instead of sleeping: `<html data-ready="true">` (set by
`src/ui/ReadySignal.tsx` in mock/dev builds once boot is over and no query is
fetching), no `[aria-busy=true]` / `.skeleton` left, no finite animation
running, fonts loaded — still true two frames later. Loading-state pictures
wait for the skeleton instead; offline-cache specs wait for the persisted
cache. Run two worktrees side by side with `KLORN_E2E_PORT`.

## Architecture

```
src/
  main.tsx, app/App.tsx        boot: services → providers → Root (Welcome | Cover | Shell)
  app/services.ts              API client singleton + in-memory session token
  app/theme.tsx                light/dark (OS default, override in Accounts), system bars
  config.ts, config-shared.ts  API base resolution + validation
  api/client.ts                fetch transport (CapacitorHttp on native), Bearer, timeouts, typed errors
  api/endpoints.ts             every route the app calls, typed from @klorn/contract (+ api/wire.ts)
  api/queries.ts               TanStack Query hooks + keys
  api/query-client.ts          offline-first cache persisted 24 h (Preferences / localStorage)
  api/mock/                    fetch shim + fixtures (`--mode mock`; never in `npm run build`)
  auth/                        session (Keychain/Keystore), OAuth relay/poll, PKCE
  i18n/                        en ko ja zh es fr de; device locale default; plural forms;
                               one chunk per catalog, only the active one loaded before first render
  router/                      typed routes + deep links, tab memory, Android back decision
  layout/                      size classes, fold posture, Shell (tabs / rail / sidebar), ListDetail
  screens/                     today, mail (list · reader · sheets · Subscriptions), cover (Flip),
                               login (Welcome), calendar, assistant, files, accounts,
                               settings (+ plans, delete) — all but Today / Welcome / cover are
                               lazy chunks (app/App.tsx); styles two screens share: styles/shared.css
  push/                        priming screen, foreground banner, tap/action routing,
                               Android data-only → local notification with actions (android.ts)
  api/queries-hub.ts           hooks for calendar/assistant/files/accounts/settings
  api/mock/*-hub.ts            fixtures + stateful mock routes for those screens
  ui/                          icons (artboard paths), states, pull-to-refresh, source badges,
                               Sheet (bottom sheet / dialog / side sheet), Switch, Snackbar (the one
                               toast: Mail's undo window and StatusNote's notify()), ReadySignal
  platform/                    native bridges: back button, browser, kv, secure store,
                               haptics, keyboard inset, push, local notifications (Android), IAP,
                               speech, link relay
  styles/                      tokens.css (light + dark), base.css, shared.css
  assets/fonts/                Geist + Instrument Serif woff2 (OFL 1.1, licences alongside)
```

### Size classes and folds (`src/layout/size-class.ts`)

| Class | Rule | Chrome |
|---|---|---|
| cover | width < 420 && height < 450 | Flip cover screen: one PUSH item, two big buttons |
| compact | width < 600 | bottom tab bar (49 + home-indicator inset, translucent blur) |
| medium | 600–840 | 76px navigation rail + list / detail |
| expanded | > 840 | list + detail; 248px sidebar from 1024 (rail below — Fold unfolded is ~884), floating "Ask the assistant" |

Two viewport segments side by side (vertical hinge) put one pane on each side
of the fold; stacked segments (tabletop) put reading on top and the rest below.
The selected item lives in the route (`/mail/:id`), so rotation, folding and
window resizes re-lay out without losing it. Without the Viewport Segments API
the app is simply "flat". Android back: close sheet → close detail → previous
tab → background the app.

### Auth (`src/auth/`)

- **Google / Apple**: system browser (`@capacitor/browser`) → the server's
  desktop flow (`/api/auth/desktop-nonce` with a PKCE challenge →
  `/api/auth/{google,apple}/login?source=desktop&appScheme=ai.klorn.app`) → the
  relay deep link `ai.klorn.app://oauth-callback?code=…` →
  `POST /api/auth/exchange-code`. No native Sign in with Apple plugin is needed;
  the Apple button shows only when `GET /api/auth/providers` lists it. In a
  browser (dev) the PKCE poll (`/api/auth/desktop-token/:nonce`) is used.
- **Email/password**: `POST /api/auth/login`; **sign-up** `POST
  /api/auth/register` (name optional, password ≥ 8). `GET
  /api/auth/signup-status` says when sign-up is invite-only
  (`BETA_GATE_ENABLED`): the form says so up front, and the server's 403 is
  shown as an invite-only refusal with a link to the waitlist; 409 points to
  sign-in. So the app works without a third-party login (4.8 still needs
  Sign in with Apple in production).
- The JWT is stored with `@aparajita/capacitor-secure-storage` (Keychain /
  Keystore, not iCloud-synced) — never localStorage on native. A 401 on a data
  call signs out and Welcome says the session ended.

### Endpoints used

| Route | Server file | Used for |
|---|---|---|
| `GET /api/auth/providers` · `POST /login` · `POST /register` · `GET /signup-status` · `GET /me` · `POST /logout` | routes/auth.ts | Welcome (sign-in, sign-up), session |
| `GET /api/auth/desktop-nonce` · `GET /desktop-token/:nonce` · `POST /exchange-code` | routes/auth.ts | Google / Apple sign-in |
| `GET /api/auth/{google,apple}/login` | routes/auth.ts, routes/social-auth.ts | system-browser leg |
| `GET /api/inbox/firewall` | routes/firewall.ts | "Needs you now" (PUSH/MEETING items + reasons), replies owed, cover screen |
| `GET /api/email/lane-counts` | routes/email-lanes.ts | lane strip (falls back to the firewall summary while MAIL_V2 / UNIFIED_HOME are off) |
| `GET /api/calendar?start&end` | routes/calendar.ts | next event, meeting count |
| `GET /api/chat/pending-actions` | routes/chat-pending-actions.ts | Approvals |
| `GET /api/email/inboxes` | routes/email.ts | connected accounts (sidebar, Accounts) |
| `GET /api/email?tier&page&inbox&search&hideHandled=1` | routes/email.ts | Mail list (infinite, server search, account filter; Done / pending Later left out by the server) |
| `GET /api/email/:id` · `PATCH /:id/read` | routes/email.ts, routes/email-mutations.ts | reader (body, `renderHtml`, attachments, proactive draft); opening marks read |
| `POST /api/email/sync` | routes/email.ts | pull-to-refresh / "sync all accounts" (primary + linked inboxes) |
| `GET /api/email/:id/reader-context` | routes/email-lanes.ts | lane + `tierReason` + neighbours (dark unless MAIL_V2 → falls back to the firewall item and the cached list) |
| `GET /api/email/:id/sender-dossier` · `/:id/thread-brief` | routes/email.ts | reader context lines (PUSH / MEETING / reply-needed QUEUE only — each is an LLM call) |
| `GET /api/email/:id/inline/:cid` · `/:id/attachments/:aid/download` | routes/email.ts, routes/email-attachments.ts | cid images inlined as data: urls; attachment open / share |
| `POST /api/email/:id/reply-draft {intent?}` | routes/email-replies.ts | AI draft; tone chips regenerate with an `intent` |
| `POST /api/email/:id/reply {body}` · `POST /api/email/send {to,subject,body,linkedInboxAccountId}` · `POST /:id/gmail-draft` | routes/email-replies.ts, routes/email-mutations.ts | send — only from the confirm sheet, a new mail from the account picked under 보내는 계정; `receipt` shown when the server sends one; save as draft |
| `POST /api/inbox/firewall/email/:emailId/dismiss` | routes/firewall.ts, judge/attention-by-email.ts | Done (swipe right, reader, notification) — sent after the 5 s client-side undo window |
| `POST /api/inbox/firewall/email/:emailId/snooze {snoozeUntil}` | routes/firewall.ts, judge/attention-by-email.ts | Later |
| `POST /api/inbox/firewall/:id/dismiss` · `/:id/snooze` | routes/firewall.ts | the Flip cover (it holds firewall items), a notification with only an `attentionItemId`, and the fallback while an older server lacks the by-email routes |
| `POST /api/inbox/firewall/email/:emailId` · `/:id/undo` · `POST /:id` | routes/firewall.ts | lane move (reversible); `POST /:id` only while KEYBOARD_TRIAGE keeps the by-email route dark |
| `POST` / `DELETE /api/email/:id/pin-tier` | routes/email.ts | "keep this sender here" |
| `GET /api/email/subscriptions` · `POST /subscriptions/unsubscribe` | routes/email-subscriptions.ts | Subscriptions (dark unless BULK_UNSUBSCRIBE_ENABLED — the entry point hides on 404) |
| `GET /api/calendar?start&end` · `GET /:id` · `POST /` · `POST /parse-event` | routes/calendar.ts | week agenda, event detail; **the only calendar write** (after the confirm card); "Describe it" prefill |
| `GET /api/teams` · `GET /:id/availability` | routes/teams.ts | "Team free time" (403 TEAM_REQUIRED → hidden) |
| `GET` / `POST /api/chat/conversations` · `GET` / `POST /:id/messages` | routes/chat-conversations.ts | chat (resumes the latest thread; `context.emailId`; `eventDraft` → confirm card) |
| `POST /api/chat/pending-actions/:id/approve` · `/reject` · `/snooze` | routes/chat-pending-actions.ts | Approvals (a send mints its ActionReceipt server-side) |
| `GET /api/inbox/receipt/today` · `GET /api/briefing/status` | routes/receipt.ts, routes/briefing | Activity |
| `GET /api/drive/files` · `/files/:id` · `POST /files/:id/summarize` · `GET /files/:id/download` · `GET /limits` · `POST /files` | routes/drive.ts, klorn-drive.ts | Files (404 while the drive flags are off → source hidden) |
| `GET /api/drive/google/accounts` · `POST /link` · `DELETE /accounts/:id` | routes/google-drive-link.ts | Google Drive source and account rows |
| `GET /api/email?filter=attachments` · `GET /api/email/:id` | routes/email.ts | the "Mail attachments" source |
| `POST /api/auth/google/{start,link-inbox,link-calendar}` · `POST /api/auth/outlook/link-inbox` (`?appScheme=ai.klorn.app`) · `POST /api/auth/link/complete` | routes/auth.ts, outlook-auth.ts, link-complete.ts | add Gmail / Outlook / calendar / Drive in the system browser, finished by the `link-complete` deep link |
| `GET /api/{naver,icloud,generic}-imap/status` · `POST /connect` · `POST /disconnect` | routes/imap-connect.ts | Naver / iCloud / other IMAP (beta; 404 → hidden) |
| `DELETE /api/auth/google` · `/google/linked-inboxes/:id` · `/outlook/linked-inboxes/:id` · `…/linked-calendars[/:id]` | routes/auth.ts, outlook-*.ts, caldav-calendar.ts | disconnect (behind a confirmation) |
| `GET` / `PATCH /api/automations` | routes/automations.ts | notification toggles, quiet hours, notification language |
| `DELETE /api/auth/account` | routes/auth.ts | account deletion (typed address; App Store 5.1.1(v)) |
| `POST /api/notifications/push/device-token/register` · `DELETE /push/device-token` | routes/notifications.ts | push token (FCM Android / APNs iOS); removed on sign-out |
| `GET /api/billing/status` | routes/billing.ts | Plans (never a web checkout on native — App Store 3.1.1; store offer + 3.1.2 disclosures from RevenueCat) |

### Mail (`src/screens/mail/`)

- **List** (Mail / FoldOpen / TabletLandscape artboards): account filter sheet,
  server search, lane tabs 전체 · PUSH · MEETING · QUEUE · INFO · SILENT (the
  lane filter is applied on the client too, because the server honours `tier`
  only with MAIL_V2 / UNIFIED_HOME on; SILENT is recorded, never rendered in
  전체), day-grouped inset list on phones, cards on wide panes, infinite
  scroll, pull-to-refresh, compose button, every loading / empty / error /
  offline state.
- **Swipe rows** (`SwipeRow`, `swipe.ts`): right = Done (row leaves at once,
  5 s undo, then `dismiss`; `undo-queue.ts` flushes on background), left = lane
  sheet with SILENT preselected, long press = multi-select (bulk Done / move).
  Pointer Events (touch and mouse), haptics at the threshold and on commit,
  reduced motion = no slide. Each row is followed by a focus-only "actions"
  button and the reader has a toolbar, so nothing needs a gesture.
- **Done / Later sync across devices**: they go to the by-email routes
  (`POST /api/inbox/firewall/email/:emailId/{dismiss,snooze}`, any mail in any
  account), and the list asks `hideHandled=1`, so the server leaves out mail
  that is Done or under a pending Later on every device. `hidden-store.ts` is
  only the optimistic layer: it hides the row during the undo window and the
  refetch, then shrinks to an hour once the server confirmed. When the server
  had nothing to clear (`alreadyClear`: the mail is not classified yet, or was
  already resolved), the hide stays local to this device (30 days).
- **Reader**: `renderHtml` sanitized again by `mail-html.ts` (a port of the
  web's #1455 wall) into an `<iframe sandbox="allow-same-origin">` with no
  `allow-scripts`, a CSP meta allowing images only, remote images off until
  "이미지 보기"; the app (never the mail) takes link taps: https → system
  browser, mailto → compose. Uncoloured HTML follows dark mode; designed mail
  keeps its light sheet.
- **Send** happens only from the confirm sheet, with exactly the recipient /
  subject / body shown. A new mail leaves from the account picked under
  **보내는 계정** (`linkedInboxAccountId`; connected accounts that are not
  waiting for a reconnect, generic IMAP excluded — a 501 from a Naver / iCloud
  account whose server-side send is off asks for another account); a reply
  from the mail's own account. Afterwards the sheet is the receipt: with
  `MANUAL_SEND_RECEIPTS_ENABLED` on, the server's `receipt` (`id` +
  `payloadHash`, written before the provider was called) labelled "보내기 전에
  Klorn 서버가 기록한 해시"; with it off (the default), the
  `sendEmailPayloadHash` this device computed from the confirmed bytes,
  labelled "기기에서 계산한 해시".
- **Tabletop**: reading above the hinge, the reply form below (FoldTabletop).

### Calendar · Assistant · Files · Accounts · Settings

- **Writes need a confirmation, always.** New event and team free slots go
  form → confirm card ("which calendar, who is invited") → `POST
  /api/calendar`. Chat only ever drafts. Approvals approve/reject one card at a
  time; reject asks for an optional reason in a sheet. Disconnect and account
  deletion are two-step. "Send draft" from a notification opens the approval
  card — it never sends.
- **Flag-gated sources hide on 404** (drive, Google Drive, Outlook, iCloud,
  generic IMAP, CalDAV) and team mode on 403; the mock's `?scenario=featuresOff`
  reproduces production's default flags.
- Calendar: week strip (swipe; arrows on wide layouts and for screen readers),
  legend per connected calendar (colour = the account's SourceBadge colour),
  current-time line, past events dimmed, overlap chip → the assistant with a
  pre-filled (not sent) question (`screens/assistant/handoff.ts`).
- Assistant: the expanded layout's floating button opens the same thread in a
  side sheet; on a vertical hinge chat and Activity sit one per segment.
  Voice input uses `@capacitor-community/speech-recognition` (hidden where the
  plugin is not linked, e.g. iOS SPM) or the Web Speech API.
- Files: one list across Klorn Drive / Google Drive / mail attachments, search
  by name and content (drive: server `q`, which matches summaries while D4 is
  on; attachments: client-side), open = system browser (Google page, Klorn
  signed download link) or the mail. Upload: `<input type=file>` → Klorn Drive.
- Accounts: Outlook, Naver and iCloud are marked beta; the device calendar row
  explains it is coming and asks for no permission.

### Push payload (what the server sends)

Built by `packages/api` `notify/push-apns.ts` (`buildApnsBody`) and
`notify/push-device.ts` (`buildFcmMessage`); the mail fields are
`packages/contract/src/push.ts` `NativePushMailFields`. Every push carries
`url` (a web path), `notificationId?` and `category` (the server's
`NotifCategory`, e.g. `email_urgent`). A **mail** push (the firewall's PUSH /
MEETING, an urgent sweep about one mail) also carries `emailId`, `route`
(`/mail/<emailId>`) and, when they exist, `attentionItemId` /
`pendingActionId` (the agent's reply-draft proposal; a firewall push has
none). The app routes `route`, then the
approval, then the mail, then the web `url` (`/email/:id`, `/inbox/firewall`,
`/briefing`, `/chat`, `/inbox`; `src/push/route.ts`). Every field is validated
on the device; anything unknown lands on Today.

**iOS (APNs)** — a mail push sets the action category inside `aps`:

```jsonc
{
  "aps": {
    "alert": { "title": "…", "body": "…" }, "sound": "default",
    "category": "KLORN_PUSH_MAIL",        // KLORN_PUSH_MAIL_DRAFT when pendingActionId is set
    "mutable-content": 1
  },
  "url": "/inbox/firewall", "category": "email_urgent",   // as on every push
  "emailId": "<EmailMessage.id>", "route": "/mail/<emailId>",
  "attentionItemId": "<AttentionItem.id>",               // when one is open
  "pendingActionId": "<PendingAction.id>"                // when a draft / approval exists
}
```

`AppDelegate.swift` registers exactly those two identifiers (pinned by
`src/push/android.test.ts`): `KLORN_PUSH_MAIL_DRAFT` (Send draft · In 1 hour ·
Done) and `KLORN_PUSH_MAIL` (In 1 hour · Done). "Send draft" is
`.authenticationRequired + .foreground` and opens the approval card; In 1 hour /
Done call `POST /api/inbox/firewall/email/:emailId/{snooze,dismiss}` (by
`attentionItemId` only when no `emailId` came).

**Android (FCM)** — two message shapes, chosen per device by the server
(`notify/push-device.ts` `buildFcmMessage`):

- **Notification message** (the default; every iOS-style or older Android
  build, every non-mail push, and every push while `ANDROID_DATA_PUSH_ENABLED`
  is off): the OS shows it (no buttons), a tap routes by `data`, and in the
  foreground the app shows its own banner.
- **Data-only message**: a MAIL push to a device that registered with
  `dataMessages: true` (this build sends it — `src/api/endpoints.ts`), while
  `ANDROID_DATA_PUSH_ENABLED` is on. No `notification` block; title and body
  move into `data`, plus `sentAt`:

```jsonc
// notification message
{ "token": "<FCM token>",
  "notification": { "title": "…", "body": "…" },
  "data": { "url": "/inbox/firewall", "category": "email_urgent",
            "emailId": "…", "route": "/mail/<emailId>", "attentionItemId": "…" },
  "android": { "priority": "high" } }

// data-only message (same data, plus):
{ "token": "<FCM token>",
  "data": { …, "title": "…", "body": "…", "sentAt": "<epoch ms>" },
  "android": { "priority": "high" } }
```

A data-only message is posted by the app's own native service,
`android/app/src/main/java/ai/klorn/app/push/KlornMessagingService.java`. It
replaces the plugin's `MessagingService` in the manifest and extends it, so
token rotation and every other message reach the plugin exactly as before. Its
rules (`push/KlornPushPayload.java`, unit-tested in
`android/app/src/test/…/KlornPushPayloadTest.java`) are the twin of
`src/push/android.ts` `parseDataPush`, down to the notification-id hash (both
test files pin the same vectors):

- title ≤120 / body ≤600 chars; `sentAt` older than 15 min = a replay, dropped;
- the action set follows the ids, as the server picks the APNs category:
  `pendingActionId` → the draft set, else `emailId` (or only
  `attentionItemId`) → the plain set, else no buttons; `category` is never read
  as an action set;
- `category: "email_urgent"` (PUSH-lane mail) posts on `klorn_push`
  (IMPORTANCE_HIGH), everything else on `klorn_other`. Both channels are
  created at launch (`src/platform/local-notify.ts`); the native service only
  creates one that is missing. The manifest makes `klorn_push` FCM's default
  channel and `ic_stat_klorn` its default status-bar icon, so notification
  messages ring and look the same way.

The notification shows **1시간 뒤에 · 처리 완료 · 검토하기** (In 1 hour · Done ·
Review) in the app language: the app saves the labels under
`klorn-android-push-labels` in Capacitor Preferences, and the native service
falls back to the device language. Every button is an activity intent: it
**opens the app** (unlocking first on a secure lock screen), where iOS runs
Later / Done in the background. The intent carries the plugin's own tap
contract (`google.message_id`), so it arrives in JS as
`pushNotificationActionPerformed` ("tap") on a cold start too, with
`klornAction` naming the button (`src/push/route.ts` `actionFromTap`).
`MainActivity` cancels the notification on arrival. Review opens the approval
card (or the mail); Later / Done call the same by-email routes as iOS. Nothing
is ever sent from a notification, on Android either.

**What works when (Android, precisely):**

| App state | Data-only message (opted-in device, flag on) | Notification message |
|---|---|---|
| Foreground | in-app banner (handed to the plugin → `PushLayer`) | in-app banner |
| Background, process alive | native notification **with** the three buttons | system notification, no buttons; tap routes |
| Process killed / swiped away / after reboot | native notification **with** the three buttons | system notification, no buttons; tap routes |
| App force-stopped in Settings | nothing (Android delivers no FCM to a stopped app) | nothing |

A data push the service posts is **not** handed to the plugin, so neither the
WebView path (`showDataPush`, which stays for a build without the service) nor
the plugin's launch-time replay of `lastMessage` can post it twice. If posting
natively throws, the message falls back to the plugin path.

### Gaps (server)

Mail:

- No "save attachment to Klorn Drive" route; attachments open via the share
  sheet / a download. Native file save needs `@capacitor/filesystem`.
- Server send receipts (`MANUAL_SEND_RECEIPTS_ENABLED`) are OFF by default;
  until the flag flips the app shows its own device-computed hash.

Calendar · Assistant · Files · push:

- No attachment index: Files reads `GET /api/email?filter=attachments` and then
  `GET /api/email/:id` for the newest 8 mails.
- `GET /api/drive/files` has no summaries; the first 10 rows read
  `GET /api/drive/files/:id` each (rate limit 60/min).
- Chat returns one `eventDraft`, not structured slots, so the artboard's slot
  picker appears in Calendar's "Team free time" (from `/api/teams/:id/availability`)
  rather than in the thread.
- Push: a firewall push precedes any reply draft, so it carries no
  `pendingActionId` and gets the plain set (In 1 hour · Done). The agent's
  proposal push for a reply (`send_email` with `in_reply_to_email_id`) carries
  the mail's `emailId` and the approval's `pendingActionId`, so it gets the
  draft set (`agentcore/proposal-push-target.ts`). Android buttons need
  `ANDROID_DATA_PUSH_ENABLED` on the server (OFF by default); until then
  Android gets notification messages without buttons.
- `GET /api/teams` needs a saved team; teams are created on the web only.

## Native configuration

- **iOS**: `TARGETED_DEVICE_FAMILY = "1,2"`, all orientations on iPad, no
  `UIRequiresFullScreen` (Split View / Slide Over / Stage Manager); the stale
  `armv7` `UIRequiredDeviceCapabilities` is removed. Dynamic Type is adopted
  through `-apple-system-body` (text sizes are rem-based). `cap sync` rewrites
  `ios/App/CapApp-SPM/Package.swift` (`speech-recognition` has no
  Package.swift — pre-existing). Push: `App/App.entitlements`
  (`aps-environment`, `CODE_SIGN_ENTITLEMENTS` on Debug and Release; the App
  Store export re-signs it as production). `App/PrivacyInfo.xcprivacy` is in
  the App target's Resources phase. No calendar plugin is linked (the old
  Samsung-calendar probe and `@ebarooni/capacitor-calendar` are gone), so the
  binary uses no EventKit and needs no calendar usage string.
- **Android**: `resizeableActivity`, no orientation lock, configChanges cover
  screen size / layout / smallest width (fold, unfold, multi-window),
  `adjustResize` for the keyboard, `READ_CALENDAR` removed (no feature uses it).
  `android:allowBackup="false"` plus `dataExtractionRules`
  (`res/xml/data_extraction_rules.xml`) that exclude every domain from cloud
  backup and device-to-device transfer, so the offline cache and the session
  never come back on a restored or new phone.
  Capacitor 8 SystemBars injects `--safe-area-inset-*` for edge-to-edge.

### Verify on device / CI (cannot run in a container without the Android SDK / Xcode)

- Android `./gradlew assembleDebug` and an iOS archive build with the new
  plugins (secure-storage, haptics, keyboard, preferences, share, splash-screen).
- Google sign-in round trip on both platforms (relay deep link arrives, the
  browser closes, Today loads); Apple once `APPLE_LOGIN_ENABLED` is on.
- Keychain / Keystore persistence across relaunch; sign-out wipes token + cache.
- Airplane-mode cold start shows the cached Today with the offline banner.
- Android back: sheet → detail → previous tab → background.
- Mail: swipe right / left with a finger (threshold haptic, commit haptic),
  long-press multi-select, the composer above the keyboard on iOS
  (`keyboardWillShow`) and Android (`adjustResize`), links from a mail opening
  the system browser, an attachment opening in the share sheet.
- Galaxy Z Fold (flat / half-folded / rotated), Z Flip cover screen, Samsung
  pop-up window, iPad Split View + Stage Manager, Dynamic Type at 200%.
- Safe areas on notch / Dynamic Island / gesture-nav devices.
- Account links: Gmail / Outlook / Google Drive consent in the system browser
  returns through `ai.klorn.app://link-complete?h=…` (new Android intent
  filter; iOS already registers the scheme), the browser closes and the row
  appears.
- Push: priming → OS prompt → token registered (Android FCM, iOS APNs);
  foreground banner; tap routing; iOS long-press actions (Send draft asks for
  unlock and opens the approval; In 1 hour / Done run without opening the app
  — verify the WebView wakes for them, else switch them to `.foreground`).
  `AppDelegate.swift` was edited without a Swift toolchain here.
- Android data-only push (`@capacitor/local-notifications`, Kotlin, linked by
  `cap sync` but not built here): with the app backgrounded, a data-only
  message posts a notification on `klorn_push` with 1시간 뒤에 · 처리 완료 ·
  검토하기; each opens the app and snoozes / dismisses / opens the approval;
  the channel shows as "PUSH mail" with importance high in system settings;
  killed app → nothing (documented above).
- RevenueCat purchase / restore / manage with `VITE_REVENUECAT_IOS_KEY` /
  `_ANDROID_KEY` set (release builds get them from `mobile-release.yml`); the
  offer card's length / price per period from the real package; plan refresh
  after the webhook.
- iOS: an archive signs with `App.entitlements` (`aps-environment` →
  production on export) and carries `PrivacyInfo.xcprivacy` (Organizer →
  Generate Privacy Report); the pbxproj was edited without Xcode here.
- Android: `allowBackup="false"` + `dataExtractionRules` build cleanly (lint
  may warn that the attribute is API 31+, which is expected).
- Multipart upload through CapacitorHttp (`POST /api/drive/files`, `size`
  before `file`) and the `<input type=file>` picker on both platforms.
- Keyboard: the composer rides above the keyboard, the tab bar hides.
- Speech recognition on Android; hidden on iOS while the plugin is unlinked.

## Native setup (unchanged from the WebView shell)

### Prerequisites (one-time, for building/iterating)

> **JDK 21 required** — Capacitor 8's Android libraries compile to Java 21.
> Building with JDK 17 fails (`invalid source release: 21`). Android Studio's
> bundled JDK is fine; for CLI builds: `brew install openjdk@21` and set
> `JAVA_HOME` to it.

```bash
# 1. Android Studio (installs the Android SDK + platform-tools through its wizard)
brew install --cask android-studio
#    Launch it once → "Standard" setup → let it download the SDK.

# 2. Put adb on PATH
echo '\nexport ANDROID_HOME="$HOME/Library/Android/sdk"\nexport PATH="$ANDROID_HOME/platform-tools:$PATH"' >> ~/.zshrc
source ~/.zshrc && adb version
```

**Galaxy device:** Settings → About phone → Software info → tap **Build number 7×**
(enables Developer options) → Settings → Developer options → **USB debugging ON**
→ connect by USB → approve the prompt → verify with `adb devices`.

---

### Enable native push (FCM) — once the app registers for push again

1. Firebase console → add an **Android app** with package name **`ai.klorn.app`**.
2. Download **`google-services.json`** → `apps/mobile/android/app/` (gitignored).
3. Firebase → Project settings → Service accounts → generate a key; set it on the
   API (Render) as `FIREBASE_SERVICE_ACCOUNT` (the full JSON as one string).
4. `npx cap sync android` and rebuild.
5. In the app, sign in, then `POST /api/notifications/push/device-test` rings the phone.

For iOS later: also upload an APNs auth key (.p8) to Firebase + `npx cap add ios`.

---

### iOS push (implemented — provide an APNs key to activate)

`@capacitor/push-notifications` returns an **APNs token** on iOS (not an FCM
token), so iOS delivery goes **straight to APNs** (`packages/api/src/push-apns.ts`,
HTTP/2 + an ES256 provider JWT) rather than through FCM. This was the chosen path
(over unified `@capacitor-firebase/messaging`) because it keeps the app
Firebase-free on iOS and the web bundle lean. Both channels run after the same gates in
`sendPushNotification` — FCM for Android, APNs for iOS.

To activate iOS push, create an **APNs auth key (.p8)** in the Apple Developer
portal and set on the API (Render):

```
APNS_KEY_P8=<.p8 contents>   APNS_KEY_ID=<10-char key id>   APNS_TEAM_ID=<team id>
APNS_BUNDLE_ID=ai.klorn.app  APNS_PRODUCTION=false   # true for TestFlight/App Store
```

Absent → iOS push is skipped (logged), like missing VAPID/FCM. An iOS device
token registers harmlessly either way. Use `APNS_PRODUCTION=false` for Xcode
debug builds (they get sandbox APNs tokens); `true` for TestFlight/App Store.

