# App Review notes — draft + reviewer-access strategy

Two parts: (1) the strategy analysis for giving Apple's reviewer a working
login, (2) the actual "Notes" text to paste into App Store Connect → App Review
Information. Facts grounded in the repo; see citations inline.

---

## 1. The core problem: the app requires sign-in

The shell loads `https://app.klorn.ai` (`capacitor.config.ts` `server.url`);
every product surface sits behind auth. Apple Guideline 2.1 requires a **full
demo account** (username + password in the App Review Information fields) for
any app with account-gated features. The complication: Klorn's value prop needs
a **connected Gmail inbox**, and Google sign-in from Apple's review network is
where naive setups die.

### What the code actually supports (this decides the strategy)

- **Email/password auth exists** alongside Google OAuth — `packages/web/src/app/login/page.tsx` has a `register`/`login` mode with name/email/password fields (`:33-37`, `:63`) and a server-side `signup-status` gate (`:83-88`, may be closed to the public).
- Google OAuth runs in the **system browser** (RFC 8252) with a deep-link relay back to the app (`Info.plist:64-74`, scheme `ai.klorn.app`; `apps/mobile/OAUTH_RELAY.md`).
- A Gmail inbox is **linked to an account server-side** after OAuth; once linked, triage/briefing/queue work without re-authing Google on each login (linked-inbox routes in `packages/api/src/routes/auth.ts`, e.g. `/google/linked-inboxes`).

### Option analysis

| Option | How | Risks | Verdict |
|---|---|---|---|
| **A. Hand Apple a demo Google account** (reviewer signs in with Google) | Put Google credentials in review notes | 1) Apple's reviewers log in from unusual IPs/devices → Google's **suspicious-login interstitial or outright block** (recovery-phone challenge the reviewer can't pass). 2) 2FA: if on, reviewer is stuck; if off, Google may force re-verification anyway. 3) Restricted Gmail scopes + un-CASA-verified OAuth client shows the "unverified app" scare screen or caps logins (`STORE_SUBMISSION.md` §D — CASA is still pending). 4) Sharing Google credentials skirts Google ToS. | ❌ Reject. Highest rejection probability. |
| **B. Email/password demo account, Gmail pre-linked by founder** | Founder creates `applereview@klorn.ai`-style account via the register flow, then links a dedicated demo Gmail (fresh Google account, seeded with realistic mail) to it **before** submitting. Reviewer logs in with plain email+password and lands on a live, populated command center. | Minimal: signup gate may be closed (`signup-status`) — irrelevant, the founder creates the account beforehand; the pre-linked Gmail token must stay fresh (open the account the day of submission to confirm the inbox is live). | ✅ **Recommended.** Reviewer never touches Google auth; every tier, the queue, and the briefing are demonstrable with real data. |
| **C. No-login demo mode** | Let the reviewer browse without an account | Doesn't exist in the product — everything routes to `/login`. Building a fake-data demo mode is real scope and undermines the "real inbox" story. | ❌ Not worth building for v1. |
| **D. TestFlight-style test user / feature flag for review window** | Register the reviewer as a test user during review | Apple review accounts are anonymous; you can't pre-register their identity. Flags can keep risky features off during review, but that's orthogonal to login. | ➖ Use flags only to keep unfinished surfaces hidden; not a login solution. |
| **Backup for all options: demo video** | Attach a link (App Review notes) showing push arriving, triage happening live | None — costs an hour | ✅ Do it as insurance; reviewers use it when a live inbox looks empty at review time. |

### Recommendation (one line)

**Option B: ship a dedicated email/password demo account with a founder-pre-linked, mail-seeded demo Gmail inbox, plus a short demo video link — the reviewer never touches Google OAuth.**

Prep checklist for the demo account (founder, ~1h):
1. Create a fresh Google account (not your real inbox — reviewers can read everything in it).
2. Seed it: 15–20 realistic emails spread across the four tiers (an urgent one for PUSH, a couple needing decisions for QUEUE, newsletters for SILENT/AUTO).
3. Register the demo Klorn account via email/password; link the demo Gmail via OAuth yourself, on your device.
4. Verify on a clean device: login → populated command center, Mail tiers, briefing renders.
5. On submission day, re-open once to confirm the Gmail link/token is healthy.

---

## 2. Paste-ready App Review notes (EN)

```
DEMO ACCOUNT
Sign in with the email/password demo account provided in the fields above
(no Google sign-in needed — a demo Gmail inbox is already connected to it).
After login you land on the command center with live triaged mail.

WHAT THE APP IS
Klorn is an "attention firewall" for email. It connects to the user's Gmail
and classifies every incoming message into one of four tiers:
PUSH (urgent — native push notification), QUEUE (needs a decision — appears
as a decision card), SILENT (kept, no interruption), AUTO (noise). It also
generates a morning briefing summarizing the inbox.

SUGGESTED REVIEW PATH (5 minutes)
1. Log in with the demo account → Home command center shows the triaged inbox.
2. Open Mail → see the four tiers on real messages.
3. Open a QUEUE decision card → approve/hold flow (nothing is emailed to real
   third parties from the demo inbox without explicit approval).
4. Open Briefing → the generated morning briefing.
5. Settings → notification preferences and self-service "Delete account"
   (Guideline 5.1.1(v) compliance).

SIGN-IN OPTIONS (Guideline 4.8)
The app offers its own email/password account creation alongside Google
sign-in, so a third-party-only login situation does not arise. Google sign-in
opens in the system browser per RFC 8252 (no credential capture in a web view).

BACKGROUND PUSH (why "remote-notification" background mode)
Klorn's core promise is that URGENT mail reaches the user even when the app is
closed. The server sends APNs alerts when a PUSH-tier email arrives; these are
visible, user-facing notifications (not silent background processing). The
background mode lets the app refresh the inbox state when a notification
arrives so tapping it opens the already-updated message. Notifications are
opt-in via the standard iOS permission prompt after login.

NATIVE FUNCTIONALITY (re: Guideline 4.2)
While Klorn renders its UI from our server (which keeps the mail firewall
logic consistent and instantly updatable across platforms), the app is not a
repackaged website — it integrates platform capabilities that the website
cannot provide:
- Native push notifications via APNs (the core product mechanism: PUSH-tier
  mail alerts), including opening the app from a notification.
- Native Google sign-in via the system browser with a registered deep-link
  return scheme (ai.klorn.app://oauth-callback).
- Native in-app purchase via StoreKit (RevenueCat) for the subscription —
  no external purchase flow is shown on iOS (Guideline 3.1.1).
- Microphone/speech permissions are declared for voice dictation of assistant
  messages using Apple's on-device speech recognition.
A demo video showing push delivery end-to-end is linked below.

DEMO VIDEO
[link — record before submitting: push arriving on a locked iPhone, tap →
opens the message in-app]

DATA & PRIVACY
Gmail data is used only to run the mail firewall for the signed-in user
(Google Limited Use). No ads, no third-party trackers; analytics is
first-party and limited to five coarse events (app_open etc.). Account +
all data are user-deletable in Settings.
```

### Field values to enter alongside the notes

| ASC field | Value |
|---|---|
| Sign-in required | Yes |
| Demo account user name | (the email/password account from the prep checklist) |
| Demo account password | (ditto — rotate after approval) |
| Contact phone / email | founder's real, reachable contact — reviewers do call |

---

## 3. Honesty guardrails (don't over-claim)

- **Voice on iOS**: the `@capacitor-community/speech-recognition` plugin ships
  as CocoaPods-only; under the Capacitor 8 SPM build it is **not linked** on
  iOS — `packages/web/src/lib/use-speech-input.ts` probes `available()` and
  hides the mic button when it rejects (see the comment block in that file).
  The notes above therefore say permissions are *declared for* dictation, and
  the 4.2 case leans on push/sign-in/IAP, not voice. If you want voice in the
  4.2 story, link the plugin via CocoaPods first — otherwise a reviewer who
  can't find the mic button reads the claim as false.
- **IAP**: only mention StoreKit/RevenueCat in the notes if
  `NEXT_PUBLIC_REVENUECAT_IOS_KEY` is set for the store build
  (`packages/web/src/lib/native/iap.ts:25`). If v1 ships free-only, delete that
  bullet and the paywall must not appear (`subscription-section.tsx` gates on
  `isNativePlatform()` — verify the paywall screen is unreachable without IAP).
- **Do not** mention Samsung/on-device calendar — the probe was removed
  (`STORE_SUBMISSION.md`), there is no shipped feature.
