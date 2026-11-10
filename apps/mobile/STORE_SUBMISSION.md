# Klorn — App Store + Google Play submission status

Status of getting the bundled app (`ai.klorn.app`) onto both stores, as of
2026-10-16. Three kinds of item: **[CODE — done]** (in the repo),
**[CODE — open]** (a repo change still needed) and **[YOU]** (accounts,
consoles, secrets — only the founder can do them).

Where things are:

| Need | File |
|---|---|
| Step-by-step order to "Waiting for Review" | `store-pack/submission-checklist.md` |
| Console click-paths and the exact GitHub / Render secret names | `docs/launch/mobile-store-setup.md` |
| Listing text, EN + KO, with character counts | `store-pack/metadata.md` |
| App Privacy + Data safety answers, privacy-manifest edit | `store-pack/privacy-labels.md` |
| App Review notes, Play app-access text, demo account | `store-pack/review-notes.md` |
| Screenshot sizes, captions, the capture command | `store-pack/screenshots-plan.md`, `store-pack/capture/` |
| What the app does, its endpoints, the device checks | `README.md` |

---

## What changed: the bundled app

The app is a React + TypeScript SPA built into the binary (`src/` →
`dist/`), talking to the API directly. It no longer loads `app.klorn.ai` in a
WebView (`capacitor.config.ts` has no `server.url`), so the old notes about
"the shell shows whatever web is deployed", `allowNavigation`, the bundled
offline error page and `NEXT_PUBLIC_*` build variables no longer apply. Web
deploys do not change the mobile app; only a new `mobile-v*` build does.

## Release flow

- **Every PR / push to `main` touching `apps/mobile/**`** →
  `.github/workflows/mobile.yml`: typecheck, vitest, build, Playwright
  screenshots (artifact **`mobile-screenshots`**), Android debug APK
  (`klorn-android-debug`), iOS simulator build. No secrets.
- **Tag `mobile-v<x.y.z>`** (or run it by hand) →
  `.github/workflows/mobile-release.yml`: version from the tag, build number
  from the run number; signed `.aab` → Play **internal** track (artifact
  `klorn-android-release`), archive → **TestFlight**. Each job skips with a
  notice until its secrets exist. Google requires the very first `.aab` to be
  uploaded by hand.
- Promotion to review / production is done in the consoles.

---

## [CODE — done]

Verified in `apps/mobile/src` on 2026-10-16:

| Store requirement | Where |
|---|---|
| Native push: priming screen before the OS prompt, token registration (`POST /api/notifications/push/device-token/register`), removal on sign-out and account deletion, foreground banner, tap → route; iOS action categories `KLORN_PUSH_MAIL` / `KLORN_PUSH_MAIL_DRAFT` (the server's `aps.category`) | `src/platform/push.ts`, `src/push/`, `AppDelegate.swift` |
| iOS push entitlement: `aps-environment` in `App.entitlements`, `CODE_SIGN_ENTITLEMENTS` on Debug + Release | `ios/App/App/App.entitlements`, `ios/App/App.xcodeproj/project.pbxproj` |
| Privacy manifest in the App target with the §2 data types | `ios/App/App/PrivacyInfo.xcprivacy`, `project.pbxproj` (Resources) |
| In-app purchase (3.1.1): RevenueCat purchase / restore / manage; no web checkout or external purchase link anywhere; release builds get the SDK keys | `src/platform/iap.ts`, `src/screens/settings/PlansScreen.tsx`, `.github/workflows/mobile-release.yml` |
| Subscription disclosures (3.1.2): title, length, price per period, auto-renew, how to cancel, Terms + Privacy links, Restore | `src/screens/settings/PlansScreen.tsx`, `plans-model.ts` |
| Email sign-up (works without a third-party login; invite-only state shown honestly) | `src/screens/login/WelcomeScreen.tsx` (`POST /api/auth/register`) |
| Account deletion (5.1.1(v)): Settings › Delete account, typed address, `DELETE /api/auth/account`, then wipe and sign-out | `src/screens/settings/DeleteAccountScreen.tsx` |
| Sign in with Apple / Google (system browser + `ai.klorn.app://oauth-callback` relay) and email; session in Keychain / Keystore | `src/auth/`, `src/screens/login/WelcomeScreen.tsx` |
| Offline: 24 h persisted cache, offline banner, wiped on sign-out | `src/api/query-client.ts`, `src/auth/session.tsx` |
| Phones, foldables (Fold book / tabletop, Flip cover), tablets (iPad all orientations, Split View, Stage Manager); Dynamic Type | `src/layout/`, `README.md` "Native configuration" |
| Privacy / terms links in Welcome and Settings (`https://klorn.ai/privacy/`, `/terms/`) | `WelcomeScreen.tsx`, `src/screens/settings/parts.tsx` |
| Export compliance in-binary (`ITSAppUsesNonExemptEncryption=false`); remote-notification background mode | `ios/App/App/Info.plist` |
| Android: `resizeableActivity`, no orientation lock, minimal permissions (INTERNET, POST_NOTIFICATIONS, RECORD_AUDIO for dictation), target SDK 36 | `android/` |
| CI build + signed release + store upload | `.github/workflows/mobile.yml`, `mobile-release.yml` |
| No unused native plugin: the calendar plugin and the probe are removed (no EventKit without a usage string) | `package.json`, `capacitor.config.ts`, `ios/App/CapApp-SPM/Package.swift`, `android/capacitor.settings.gradle` |
| Accurate metadata (2.3): Welcome names Gmail, Google Workspace, Naver (beta), iCloud (beta) only; screenshot fixtures use fictional senders and no Outlook | `WelcomeScreen.tsx`, `src/i18n/locales/`, `src/api/mock/` |
| Android: no Auto Backup / device transfer of the cache or session | `android/app/src/main/AndroidManifest.xml`, `res/xml/data_extraction_rules.xml` |

Resolved since the WebView-era list: native push in the app itself, IAP and
account deletion inside the bundled app, settings, the "thin wrapper" profile
(4.2) and the WebView offline page. **Google OAuth verification for the Gmail
scopes is complete** (CASA Tier 2, 2026-10-03 per the landing), so it no longer
gates the stores.

## [CODE — open] (details: `store-pack/submission-checklist.md` Phase 1)

1. Android App Links: add the Play **app signing** SHA-256 to
   `website/.well-known/assetlinks.json` after the first Play upload.
2. Privacy-policy additions (`store-pack/privacy-labels.md` §4) — a web PR.

Resolved on 2026-10-16 (table above): push entitlement, privacy manifest in
the target, IAP keys in the release build, Plans disclosures, Welcome copy,
the calendar plugin, screenshot fixtures, `clearHidden()` on sign-out, Android
backup, email sign-up.

Not blockers, tracked in `README.md` → "Gaps": only the agent's reply-draft
proposal push carries a `pendingActionId` (Send draft); a firewall push
precedes any draft and carries In 1 hour · Done. Android action buttons need
`ANDROID_DATA_PUSH_ENABLED` on the server (OFF by default; the app's native
service is ready for it); voice input is hidden on iOS (speech plugin not
linked under SPM).

## [YOU] (order and click-paths: `submission-checklist.md` Phases 0, 2, 5–6 and `docs/launch/mobile-store-setup.md`)

1. Apple Developer Program + Paid Apps agreement, banking, tax. Google Play
   developer account (personal accounts: closed test with 12 testers for 14
   days before production — confirm the current numbers in the console).
2. App Store Connect API key and Play upload keystore + service account →
   GitHub secrets.
3. APNs key and Firebase → Render env (`APNS_*`, `FIREBASE_SERVICE_ACCOUNT`)
   and `ANDROID_GOOGLE_SERVICES_JSON_BASE64`.
4. **Sign in with Apple in production** (`APPLE_*` env, then
   `APPLE_LOGIN_ENABLED=true`) — needed for Guideline 4.8 because Google
   sign-in is offered.
5. Subscription products in both consoles, RevenueCat offering, webhook +
   `REVENUECAT_WEBHOOK_AUTH`; GitHub secrets `VITE_REVENUECAT_IOS_KEY` /
   `VITE_REVENUECAT_ANDROID_KEY` (else store builds ship with IAP off).
   App ID `ai.klorn.app` with Push Notifications enabled (the entitlement is
   in the project now).
6. Tag `mobile-v1.0.0`; upload the first `.aab` by hand; run the device pass.
7. Demo account, screenshots, listings, privacy answers, privacy-policy
   additions (`privacy-labels.md` §4).
8. Submit.

## Build commands (local)

```bash
cd apps/mobile
npm ci
npm run build && npx cap sync   # = npm run sync
npm run open:ios                # Xcode (signing, capabilities)
npm run open:android            # Android Studio
# store screenshots
npx playwright test --config store-pack/capture/playwright.store.config.ts
```
