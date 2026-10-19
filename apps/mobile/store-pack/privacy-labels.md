# App Privacy (Apple) and Data safety (Google) — answers for the bundled app

Revised 2026-10-16 for the bundled app (`apps/mobile/src`). The app no longer
loads the web app, so the web bundle's SDKs (`@sentry/browser`, the web
`track.ts` analytics sender) are **not** in it. Every answer is tied to code
below; answer the two conditional rows from the build you actually upload.

What "collected" means: Apple — data sent off the device and kept longer than
needed to answer the request; Google — data sent off the device. Klorn's API
(`packages/api`, Postgres on Supabase) keeps account, mail, calendar, chat and
action data while the account exists, so all of that counts. Data that only
stays on the phone (the offline cache below) is not "collected" for either
store, but it is described here because reviewers and the privacy policy ask.

---

## 1. What the app sends and keeps

| Data | Leaves the device? | Kept where, how long | Code |
|---|---|---|---|
| Account email address, name (from Google / Apple sign-in, or the email login) | Yes | API database while the account exists | `src/auth/`, `routes/auth.ts` |
| Account id (server user id) | Yes | API database; also RevenueCat's `appUserID` when IAP is on | `src/platform/iap.ts` (`Purchases.configure({ appUserID })`) |
| Mail from connected accounts (headers, bodies, attachments), AI summaries and drafts | Mail is fetched server-side from Gmail / IMAP, not from the phone; the app sends replies and new mail the user confirms | API database while the account exists; AI providers per request (Gemini API, OpenRouter — privacy policy "AI Processing") | `routes/email*.ts`; send only from the confirm sheet (`src/screens/mail/compose.tsx`) |
| Calendar events (Google Calendar, CalDAV) and events the user creates | Created events: yes (after the confirm card) | API database | `POST /api/calendar` |
| Assistant chat, lane moves, Done / Later, approvals and rejections (with an optional reason) | Yes | API database | `routes/chat-*.ts`, `routes/firewall.ts` |
| Server-side usage events keyed by user id: `push_sent`, `queue_action` | Generated on the server | API `analyticsEvent` table (first-party, no third-party analytics) | `packages/api/src/analytics.ts`, `notify/push.ts:302` |
| Push token (APNs on iOS, FCM on Android) | Yes | API, until sign-out (`DELETE /push/device-token`) or account deletion | `src/platform/push.ts`, `routes/notifications.ts` |
| Purchases | Through StoreKit / Play Billing to RevenueCat, then a webhook sets the plan | RevenueCat + `user.plan` | `src/platform/iap.ts`, `routes/webhook.ts` (`/api/webhook/revenuecat`) |
| Files uploaded to Klorn Drive (any file the picker allows, photos included) | Yes, only while the drive flags are on in production | API storage | `src/screens/files/FilesScreen.tsx` (`<input type=file>`) |
| Speech | **No audio leaves through the app.** iOS: the speech plugin is not linked (SPM), the mic button is hidden. Android: the system recognizer returns text; only the text is sent, as chat | — | `src/platform/speech.ts` |
| Crash / diagnostics | **No.** There is no Sentry or other crash SDK in `apps/mobile/package.json` or `src/` | — | (grep `sentry` in `apps/mobile`: no hits) |
| Advertising id, location, contacts, health, browsing history | **No** | — | no plugin or permission for them |

### On the device only (not "collected")

- **Offline cache** (`src/api/query-client.ts`): successful reads — Today,
  mail lists, **opened mail bodies**, calendar, approvals, accounts — are
  persisted with Capacitor Preferences (iOS `UserDefaults`, Android
  `SharedPreferences`) for at most **24 h** (`CACHE_MAX_AGE_MS`), keyed to the
  signed-in user, **encrypted** with AES-256-GCM under a random key kept only
  in the Keychain / Keystore as a device-only item (`src/platform/cache-crypto.ts`;
  iOS `afterFirstUnlockThisDeviceOnly`, so an iCloud / iTunes backup holds
  ciphertext without its key). Wiped — key included — on sign-out, when the
  server answers 401, and after account deletion (`src/auth/session.tsx` `wipe()`). Searches, provider lists,
  team slots and drive limits are never persisted (`meta.persist: false`).
- **Session token**: Keychain / Android Keystore via
  `@aparajita/capacitor-secure-storage`, not iCloud-synced; removed on
  sign-out.
- **Done / Later list** (`src/screens/mail/hidden-store.ts`): email ids and
  "hide until" times, no content — an optimistic layer over the server's
  `hideHandled` list (an hour once the server confirmed; up to 30 days for
  mail the server had nothing to clear for). Cleared on sign-out, on a 401 and
  after account deletion (`clearHidden()` in `session.tsx` `wipe()`).
- Push token copy, "push primed" flag, theme and language choice (Preferences).

---

## 2. Apple — App Privacy questionnaire

| Question | Answer |
|---|---|
| Do you or your third-party partners collect data from this app? | **Yes** |
| Is any data used to track users? | **No** — `NSPrivacyTracking=false`, no tracking domains, no ad / attribution SDK |

Declare each type below as **Linked to the user: Yes · Used for tracking: No**.

| Category → type | Purposes | Notes |
|---|---|---|
| Contact Info → **Name** | App Functionality | From the Google / Apple profile at sign-in |
| Contact Info → **Email Address** | App Functionality | Sign-in and the connected accounts |
| User Content → **Emails or Text Messages** | App Functionality | The product: mail is synced, classified, summarised, drafted and sent on confirmation |
| User Content → **Other User Content** | App Functionality | Assistant chat, calendar events, approvals, lane corrections |
| Identifiers → **User ID** | App Functionality | Klorn account id; RevenueCat `appUserID` |
| Identifiers → **Device ID** | App Functionality | The APNs push token. Apple's wording is about device-level identifiers; declaring the push token is the conservative choice and matches the Play answer — keep it unless you decide otherwise deliberately |
| Usage Data → **Product Interaction** | App Functionality, Analytics | Server records of Done / Later / lane moves / approvals, plus the first-party `push_sent` / `queue_action` events |
| Purchases → **Purchase History** — **conditional** | App Functionality | Declare **only if** the uploaded build was built with `VITE_REVENUECAT_IOS_KEY` |
| User Content → **Photos or Videos** — **conditional** | App Functionality | Declare **only if** Klorn Drive upload is on in production (`DRIVE_ENABLED`); the file picker can pick photos |

Answer **not collected** for: Health & Fitness, Financial Info (other than
the purchase row), Location, Sensitive Info, Contacts (the address book is
never read — addresses inside mail are covered by "Emails"), Browsing History,
Search History (mail search is sent per request; I found no code that stores
the query — re-check `routes/email.ts` if you want certainty), Diagnostics,
Audio Data, Gameplay Content, Customer Support, Other Data.

Third parties inside the binary: **RevenueCat** (purchase history + the
account id, only with a key), **Apple APNs** (the token). Service providers on
the server side — Render, Supabase, Vercel, Google Gemini API, OpenRouter,
Resend — process data for Klorn and are listed in the privacy policy.

### `PrivacyInfo.xcprivacy` — matches the table (done 2026-10-16)

`apps/mobile/ios/App/App/PrivacyInfo.xcprivacy` is a member of the App target
(`project.pbxproj`: PBXFileReference, PBXBuildFile, Resources phase), so every
archive carries it. It declares Name, Email Address, Other User Content,
Emails or Text Messages, User ID, Device ID, Product Interaction (App
Functionality + Analytics) and Purchase History — every one linked, none used
for tracking — with `NSPrivacyTracking` false, no tracking domains, and the
UserDefaults required-reason entry (`CA92.1`, Capacitor Preferences).

Keep it in step with the questionnaire:

- **Purchase History** is declared because store builds carry
  `VITE_REVENUECAT_IOS_KEY` (`mobile-release.yml`). For a build uploaded
  without it, remove that dict and the questionnaire row.
- **Photos or Videos**: add the same shape
  (`NSPrivacyCollectedDataTypePhotosorVideos`) only if Klorn Drive upload is
  on in production.
- After the first archive, run Xcode Organizer → the archive → **Generate
  Privacy Report**. It merges the SDKs' own manifests (Capacitor, RevenueCat,
  secure storage); if it lists a type or a required-reason API not in the
  table above, add it to the questionnaire.

---

## 3. Google Play — Data safety form

### Overview answers

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** — the API base must be `https` (`src/config-shared.ts` rejects http except localhost / the emulator) |
| Do you provide a way for users to request that their data is deleted? | **Yes** — in the app (Settings › Delete account) and on the web |
| Delete account URL | `https://app.klorn.ai/privacy#retention-and-deletion` |
| Is data shared with third parties? | **No** for every type. Google's form excludes transfers to service providers that process data on your behalf (hosting, AI providers under API terms, RevenueCat, FCM) |

### Types collected (all: collected **Yes**, shared **No**, processed ephemerally **No**)

| Category → type | Required or optional | Purposes |
|---|---|---|
| Personal info → **Name** | Required | App functionality, Account management |
| Personal info → **Email address** | Required | App functionality, Account management |
| Personal info → **User IDs** | Required | App functionality, Account management |
| Messages → **Emails** | Required | App functionality |
| Calendar → **Calendar events** | Optional (only when a calendar is connected) | App functionality |
| App activity → **App interactions** | Required | App functionality, Analytics |
| App activity → **Other user-generated content** (assistant chat, approval reasons) | Optional | App functionality |
| Device or other IDs → **Device or other IDs** (the FCM token) | Optional (only when notifications are on) | App functionality |
| Financial info → **Purchase history** — **conditional** | Optional | App functionality — only if the build carries `VITE_REVENUECAT_ANDROID_KEY` |
| Files and docs → **Files and docs** — **conditional** | Optional | App functionality — only if Klorn Drive / Google Drive is on in production |

Not collected: Location, Contacts, Health and fitness, Photos and videos
(unless you take the Files row and decide photos count — then add it,
optional), Audio (the system recognizer handles speech; the app gets text),
Web browsing, App info and performance (no crash SDK), In-app search history
(see the Apple note above), Installed apps.

---

## 4. Privacy policy — gaps to fix before submitting

The live policy (`packages/web/src/app/privacy/page.tsx`, reached through
`https://klorn.ai/privacy/`) has a **Mobile App** section since 2026-10-17
(k08200/klorn#1473): the encrypted 24 h on-device cache, Google Firebase Cloud
Messaging next to APNs, App Store / Google Play billing with RevenueCat, voice
input, no ads or tracking SDKs. Still open: the policy is English only — not a
store requirement, but the KO listing links to it.

## 5. Code-side privacy items (done 2026-10-16)

- `hidden-store.ts`: `clearHidden()` runs in `session.tsx`'s `wipe()` (sign-out,
  401, account deletion), so the Done / Later ids do not outlive the session.
- `android/app/src/main/AndroidManifest.xml`: `android:allowBackup="false"` and
  `android:dataExtractionRules="@xml/data_extraction_rules"`, which excludes
  every domain from cloud backup and device-to-device transfer — the 24 h mail
  cache (`sharedpref/CapacitorStorage.xml`) never reaches a backup or a new
  phone, matching "cleared on sign-out".
