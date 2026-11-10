# App Review notes (Apple) and App access (Google Play)

Revised 2026-10-16 for the bundled app. Two parts: how to give reviewers a
working account, then the paste-ready texts. Fill every `«…»` placeholder.

---

## 1. Reviewer access

Every screen sits behind sign-in, and the product needs a connected mail
account with real-looking mail. Reviewers sign in from unusual networks, so
**never hand them a Google login** (suspicious-sign-in challenges, 2FA,
sharing credentials against Google's terms). Instead:

**Demo account = a Klorn email/password account with a demo Gmail already
linked.** The app's "Continue with email" signs in (`POST /api/auth/login`)
and can also create an account (`POST /api/auth/register`); while sign-up is
invite-only (`BETA_GATE_ENABLED`) only an approved waitlist address can
register, so create the demo account on the web (or approve its address
first).

Prep (founder, ~1 h):

1. Make a fresh Google account for the demo — not your own mail; reviewers can
   read all of it.
2. Seed it with ~20 realistic, fictional emails across the five lanes: one
   time-critical (PUSH), a calendar invite or reschedule (MEETING), a few
   asking for a reply (QUEUE), receipts / confirmations (INFO), newsletters
   (SILENT). Add 2–3 events to its Google Calendar for today and tomorrow.
3. On `https://app.klorn.ai`, sign up with email + password (e.g.
   `appreview@«your domain»`), verify the address, then connect the demo
   Gmail + Calendar from Settings.
4. Plan: leave the account on **Free** if IAP ships in this build, so the
   reviewer can test the purchase with their sandbox account (the RevenueCat
   webhook grants Pro for sandbox purchases too — `routes/webhook.ts` does not
   filter by environment). Reply drafts and sending need Pro
   ("Writing and sending mail needs a Pro plan."); if IAP does **not** ship in
   this build, put the demo account on Pro instead, or the reply path is
   locked.
5. Install the TestFlight / internal-track build on a clean device, sign in
   with the demo account and walk the test path below once. Make sure at
   least one reply draft and one approval exist.
6. On submission day, open it once more (keeps the Gmail link fresh and new
   mail classified).

Back-up: record a 60–90 s screen video (a PUSH notification arriving on the
lock screen → tap → the message opens → swipe right / left → Review & send)
and link it in the notes. Reviewers use it when live data looks thin.

---

## 2. App Store Connect → App Review Information

| Field | Value |
|---|---|
| Sign-in required | Yes |
| User name | `«demo account email»` |
| Password | `«demo account password»` (rotate after approval) |
| Contact first / last name, phone, email | `«founder — reachable; reviewers do call»` |
| Notes | the block below |
| Attachment | optional: the demo video file |

### Notes (paste)

```
DEMO ACCOUNT
Tap "Continue with email" on the first screen and use the email and password above. A demo Gmail account and its Google Calendar are already connected to it, so no Google sign-in is needed.

WHAT KLORN DOES
Klorn shows the user's mail and calendars from their connected accounts (Gmail and Google Calendar; Naver Mail and iCloud Mail in beta) in one list. Every message is sorted into one of five lanes — PUSH, MEETING, QUEUE, INFO, SILENT — with a sentence explaining why. Lanes only sort; they never act on mail. Klorn can draft replies, but nothing is sent until the user confirms the exact message.

WHY MAIL ACCESS IS NEEDED
Reading and sorting the user's own mail is the app's whole function. The user connects each account through the provider's own consent screen (opened in the system browser). Mail is processed on Klorn's server only to provide these features for that user; it is not used for ads. Klorn's Google OAuth verification (restricted Gmail scopes) was completed in October 2026.

SUGGESTED TEST PATH (about 5 minutes)
1. Sign in → Today: "Needs you now" (PUSH and MEETING mail with reasons), lane counts, the next event, items waiting for approval.
2. A notification-permission explanation appears once after sign-in. Tap "Turn on notifications" to see the iOS prompt, or "Not now".
3. Mail tab → lane chips PUSH / MEETING / QUEUE / INFO / SILENT.
   - Swipe a row to the right: "Done". It leaves the list; the mailbox itself is not changed. "Undo" appears for 5 seconds.
   - Swipe a row to the left: a sheet to move it to another lane.
   - Long-press a row to select several.
   Nothing requires a gesture: the reader has a toolbar with the same actions, and each row has an actions button for VoiceOver and keyboard users.
4. Open a PUSH message → the reason card ("Why we told you now") → "Edit" on the reply draft → "Review & send" → a confirmation sheet shows the exact recipient, subject and body. Please send only to the demo addresses shown; a receipt appears after sending.
5. Calendar tab → this week across connected calendars. "New event" always ends at a confirmation card before anything is created.
6. Assistant tab → chat, Approvals (approve or reject one card at a time), Activity (what Klorn did today).
7. Settings: tap the initials at the top right of Today → Accounts & sources → "Settings" at the top left.
   - Notifications: what may ring, quiet hours.
   - Plans: Klorn Pro through In-App Purchase, with Restore. No external purchase links or web checkout anywhere in the app.
   - Delete account (bottom of Settings): permanent, self-service; confirmed by typing the account's address. It removes the account and its data on the server and signs the device out.

NATIVE FUNCTIONALITY (Guideline 4.2)
The interface is bundled in the app binary; it does not load a website.
- Push notifications through APNs, with an in-app explanation before the system prompt, a foreground banner, and a tap that opens the exact message.
- Sign in with Apple, Google and email. Sessions are stored in the Keychain.
- Works offline: launch in Airplane Mode and the last loaded Today and Mail appear with an offline banner (cached for up to 24 hours, cleared on sign-out).
- iPad: list and message side by side, every orientation, Split View, Slide Over and Stage Manager; Dynamic Type; light and dark appearance; haptics on swipe; the system share sheet for attachments; links open in the system browser.

PURCHASES (Guideline 3.1.1)
Klorn Pro is sold only through In-App Purchase (Settings > Plans), including Restore Purchases and "Manage subscription", which opens the App Store's own subscription page.

DATA
No ads, no tracking, no third-party analytics. Deleting the account in Settings removes the account and its data.

DEMO VIDEO
«link»
```

Edit the notes to match the build before pasting:

- **Sign in with Apple**: keep the line only if `APPLE_LOGIN_ENABLED` is on in
  production (the button is hidden otherwise). See §4 — on iOS it should be on.
- **PURCHASES**: delete the block (and the Plans line) if the build carries no
  `VITE_REVENUECAT_IOS_KEY`; Plans then says in-app subscription is not ready
  yet and offers nothing to buy.
- **Notification actions**: a mail push now carries the email id and the
  `KLORN_PUSH_MAIL` category, so long-press Reply / Later / Not urgent / Done work on iOS. They
  are still not mentioned: Send draft needs a `pendingActionId` the server
  does not set at push time yet (README "Gaps"), and a reviewer cannot
  trigger a PUSH-lane mail on demand.
- **Voice input** is not mentioned: the speech plugin is not linked on iOS, so
  the mic is hidden. `Info.plist` still carries the microphone / speech usage
  strings; that is allowed, but if a reviewer asks, the answer is "used for
  dictation where available; hidden on this build".

---

## 3. Google Play → App content → App access

Choose **"All or some functionality is restricted"** → *Add new instructions*:

| Field | Value |
|---|---|
| Name | `Demo account` |
| Username | `«demo account email»` |
| Password | `«demo account password»` |
| Any other information | paste below |

```
On the first screen tap "Continue with email" and sign in with the account above. A demo Gmail account and its Google Calendar are already connected, so no Google sign-in is needed.

Test path: Today (mail that needs attention, lane counts, next event) → Mail tab: swipe a row right to mark it Done (the mailbox is not changed; Undo appears), swipe left to move it to another lane, long-press to select several → open a PUSH message → "Edit" the draft → "Review & send" shows the exact message before anything is sent (please send only to the demo addresses) → Calendar → Assistant (chat, Approvals, Activity).

Account deletion: tap the initials at the top right of Today → Accounts & sources → "Settings" at the top left → Delete account at the bottom; confirm by typing the account's address.

Purchases are made only through Google Play Billing (Settings > Plans).

On a foldable, the list and the message show side by side when unfolded; on a Galaxy Z Flip cover screen the app shows the one PUSH item with Done / Later.
```

Other Play "App content" answers: Ads — **No**; Data safety — per
`privacy-labels.md`; Content rating, Target audience — per `metadata.md`;
News app — No; Government app — No; Financial features — None; Health — No.

---

## 4. Review risks and their answers

| Risk | Status in the code | What to do |
|---|---|---|
| **4.8 Login services** — the app offers Google sign-in, so Apple expects an equivalent privacy-preserving option | The Apple button exists but is shown only when the API lists Apple (`APPLE_LOGIN_ENABLED`, dark by default). Email sign-in and sign-up make the app usable without a third-party login, but they do not hide the address, so they do not count as the equivalent option | **Turn on Sign in with Apple in production before the iOS submission** (`APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_REDIRECT_URI` on Render, then `APPLE_LOGIN_ENABLED=true`). It runs as Apple's web flow in the browser sheet that `@capacitor/browser` opens (SFSafariViewController), not the native Sign in with Apple sheet; Apple accepts the web flow, but test the round trip on a device |
| **5.1.1(v) Account deletion** | Self-service, in the app (`DeleteAccountScreen.tsx` → `DELETE /api/auth/account`) | The path is three taps deep (Today → initials → Accounts & sources → Settings). It is reachable; the notes spell it out |
| **3.1.1 / 3.1.2 Subscriptions** | IAP only, no external links; "Manage" opens RevenueCat's `managementURL` (the store's page). Plans shows the product title, length and price per period, the auto-renew statement, how to cancel, Terms of Use + Privacy Policy links and Restore (`PlansScreen.tsx`) | Also fill the subscription's own metadata (display name, description, review screenshot) in App Store Connect, and the Terms of Use link in App Information |
| **4.2 Minimum functionality** | Bundled UI, push, offline cache, iPad layouts, Keychain session | Keep the notes' native list; attach the video |
| **2.1 Completeness** | Flag-gated sources hide on 404, so no dead buttons | Re-check the demo account the day of submission |
| **2.3 Accurate metadata** | Store copy and the Welcome screen name only accounts production connects (Gmail, Google Workspace, Naver and iCloud in beta); screenshot fixtures use fictional senders and no Outlook | Keep it so if `OUTLOOK_INBOX_ENABLED` stays dark |
