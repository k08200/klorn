# App Privacy questionnaire — answers with code evidence

Fill-in sheet for App Store Connect → App Privacy ("Privacy Nutrition Labels").
Every answer below is grounded in the repo; the questionnaire **must agree with**
`apps/mobile/ios/App/App/PrivacyInfo.xcprivacy` (see the gap flagged at the end).

Apple's definition of "collect": data transmitted off the device and retained
longer than needed to service the request. Klorn's backend (Fastify + Postgres,
`packages/api`) stores account, mail-triage, chat, and analytics data → those
count as collected. On-device-only or pass-through data does not.

---

## Top-level answers

| Question | Answer |
|---|---|
| Do you or your third-party partners collect data from this app? | **Yes** |
| Is data used to track users across apps/websites (ATT)? | **No** — `NSPrivacyTracking=false`, empty `NSPrivacyTrackingDomains` (`PrivacyInfo.xcprivacy`); no ad/tracker SDK in `apps/mobile/package.json` or `packages/web/package.json` (only Capacitor plugins, RevenueCat, `@sentry/browser`) |

---

## Data types — collected

### 1. Contact Info → Email Address

- **Collected: YES · Linked to identity: YES · Used for tracking: NO**
- **Purpose:** App Functionality (sign-in, running the mail firewall)
- Evidence:
  - Declared in `apps/mobile/ios/App/App/PrivacyInfo.xcprivacy` (`NSPrivacyCollectedDataTypeEmailAddress`, linked, app-functionality)
  - Email/password + Google OAuth auth: `packages/api/src/routes/auth.ts` (account routes; `DELETE /account` at line 1330), `packages/web/src/app/login/page.tsx:33` (email state, register mode)

### 2. Contact Info → Name

- **Collected: YES · Linked to identity: YES · Used for tracking: NO**
- **Purpose:** App Functionality (account profile)
- Evidence: the email/password **register** mode asks for a name — `packages/web/src/app/login/page.tsx:63` (`nameRef` focused first in `mode === "register"`).
- ⚠️ **Manifest gap:** `PrivacyInfo.xcprivacy` does not currently declare Name. Either add `NSPrivacyCollectedDataTypeName` to the manifest (recommended, 5-line edit) or drop the name field from signup. The questionnaire and the manifest must match.

### 3. User Content → Emails or Text Messages

- **Collected: YES · Linked to identity: YES · Used for tracking: NO**
- **Purpose:** App Functionality (the product — triage of the user's Gmail into PUSH/QUEUE/SILENT/AUTO, briefings, decision cards)
- Evidence: Gmail message ingestion & classification pipeline in `packages/api/src/routes/gmail-push.ts`, `email.ts`, `email-candidates.ts`, `firewall.ts`; data persisted in the app's own Postgres (Prisma). Gmail data use is bound by Google's Limited Use policy (CASA verification track, `apps/mobile/STORE_SUBMISSION.md` §D).

### 4. User Content → Other User Content (assistant chat)

- **Collected: YES · Linked to identity: YES · Used for tracking: NO**
- **Purpose:** App Functionality (assistant conversations, incl. voice-dictated text)
- Evidence: declared in `PrivacyInfo.xcprivacy` (`NSPrivacyCollectedDataTypeOtherUserContent`); chat persistence in `packages/api/src/routes/chat-conversations.ts`.

### 5. Identifiers → User ID

- **Collected: YES · Linked to identity: YES · Used for tracking: NO**
- **Purpose:** App Functionality, Analytics
- Evidence:
  - First-party analytics rows are keyed by `userId` — `packages/api/src/analytics.ts:36-49` (`recordEvent(userId, …)` → `prisma.analyticsEvent.create`)
  - RevenueCat is configured with the app's own user id as `appUserID` — `packages/web/src/lib/native/iap.ts:40` (`Purchases.configure({ apiKey, appUserID: appUserId })`)

### 6. Usage Data → Product Interaction

- **Collected: YES · Linked to identity: YES · Used for tracking: NO**
- **Purpose:** Analytics (first-party only — retention/engagement)
- Evidence: exactly **5 allowlisted events**, first-party Postgres, no third-party tracker — `packages/api/src/analytics.ts:17-23`:
  `app_open`, `queue_action`, `notif_muted`, `push_opened`, `push_sent`.
  Client sender: `packages/web/src/lib/track.ts:12-36` (posts to own `/api/analytics/event`; ingest allowlisted in `packages/api/src/routes/analytics.ts:28`). Events carry `userId` → answer **Linked: YES**. `meta` never contains message content (module doc, `analytics.ts:1-15`).

### 7. Purchases (Purchase History) — CONDITIONAL

- **If RevenueCat keys are set for the store build (`NEXT_PUBLIC_REVENUECAT_IOS_KEY`): Collected: YES · Linked: YES · Tracking: NO · Purpose: App Functionality**
- **If shipping v1 with IAP inert (no key): NO — do not declare.**
- Evidence: IAP is wired but inert without keys — `packages/web/src/lib/native/iap.ts:25` ("True only when running natively AND a RevenueCat key is configured"); `apps/mobile/STORE_SUBMISSION.md` §C. RevenueCat processes purchase history server-side when active. Decide based on the actual build configuration at submission time.

### 8. Diagnostics → Crash Data — CONDITIONAL

- **If `NEXT_PUBLIC_SENTRY_DSN` is set on the prod web deploy: Collected: YES · Linked to identity: NO · Tracking: NO · Purpose: App Functionality (error diagnosis)**
- **If DSN unset (current live default per code comment): NO — do not declare.**
- Evidence: `packages/web/src/lib/sentry.ts` — init gated on DSN (`:10`, `:18`); `tracesSampleRate: 0`, replays 0 (`:30-32`); the comment at `:46-48` states the live default is DSN-unset. **No `Sentry.setUser()` call exists anywhere in `packages/web/src`** → crash reports are not linked to identity ("Linked: NO" is correct). Answer at submission time based on the actual prod env.

---

## Data types — NOT collected (answer "No")

| Category | Why not |
|---|---|
| Audio Data | Voice input uses the **OS speech recognizer**; the app receives only transcribed text — `Info.plist:80-81` (`NSSpeechRecognitionUsageDescription`: "Audio is processed by Apple's speech recognition and is not stored by Klorn"), `packages/web/src/lib/use-speech-input.ts` (transcript-only callback). The transcribed text falls under User Content (#4). |
| Device ID | No advertising identifier, no fingerprinting. The APNs device token is used solely to deliver push the user opted into (`packages/web/src/lib/native/native-push.ts:15-40`, token registered at own endpoint `:55`) — functional delivery, not an identifier for analytics/tracking. If you want the maximally conservative posture, declare Identifiers → Device ID (Linked: YES, Tracking: NO, App Functionality); not required. |
| Location, Contacts, Health & Fitness, Financial Info, Sensitive Info, Browsing History, Search History | No code paths request or transmit these. No `NSLocation*`/`NSContacts*` usage strings in `Info.plist`. Calendar strings were deliberately removed (`STORE_SUBMISSION.md`, "Calendar permission prompt removed"). |
| Photos/Videos | No camera/photo permission strings, no upload path in the shell. |

---

## Third-party partners inventory (for the "third-party partners" wording)

| SDK / service | Data it touches | Tracker? |
|---|---|---|
| RevenueCat (`@revenuecat/purchases-capacitor`) | Purchase history + app user id (only when key configured) | No |
| Sentry (`@sentry/browser`, web bundle) | Crash/error events, no user identity attached (no `setUser`), traces/replays off | No |
| Google (Gmail/Calendar APIs, OAuth) | Service functionality — the user's own data accessed on their behalf | No |
| — | **No** PostHog / GA / Meta / AdMob / any ad or analytics SDK — analytics is first-party Postgres only (`packages/api/src/analytics.ts:6-9`) | — |

---

## Action items before submitting the questionnaire

1. **Fix the Name gap**: add `NSPrivacyCollectedDataTypeName` to `PrivacyInfo.xcprivacy` (linked, no-tracking, app-functionality) so manifest == questionnaire.
2. **Decide Purchases** (#7) and **Crash Data** (#8) from the real build/env at submission time; both directions are pre-written above.
3. Remember `PrivacyInfo.xcprivacy` still needs Xcode target membership (`STORE_SUBMISSION.md` §A.3) or it won't ship in the bundle at all.
