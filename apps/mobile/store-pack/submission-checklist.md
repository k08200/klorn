# Submission checklist — founder run-book (iOS + Android)

Revised 2026-10-16 for the bundled app and the CI release flow. This file is
the **order of operations**; `apps/mobile/STORE_SUBMISSION.md` is the status
and the why; `docs/launch/mobile-store-setup.md` has the console click-paths
and secret names. Do the phases in order; inside a phase the boxes can run in
parallel.

How builds reach the stores now: push a tag `mobile-v<x.y.z>` →
`.github/workflows/mobile-release.yml` builds the bundled app
(`npm run build` → `cap sync`), signs it, and uploads iOS to **TestFlight**
and Android to the Play **internal** track. Each platform job skips with a
notice while its secrets are missing. Every PR touching `apps/mobile/**` runs
`.github/workflows/mobile.yml` (typecheck, tests, build, Playwright
screenshots → artifact `mobile-screenshots`, Android debug APK, iOS simulator
build). There is no Xcode archive / Organizer upload step any more.

---

## Phase 0 — Accounts (start now; some take days)

- [ ] Apple Developer Program (individual or organization) active; App Store
      Connect → **Agreements, Tax, and Banking**: the **Paid Apps** agreement
      signed and banking + tax filled in (needed before any subscription can
      be sold or even tested outside sandbox).
- [ ] Google Play developer account. A **personal** account created after
      Nov 2023 must run a **closed test with at least 12 opted-in testers for
      14 days** before it can apply for production (Google's current rule —
      check Play Console's dashboard for the exact numbers); an organization
      account is exempt. Start that clock as soon as the first build is on a
      testing track. Payments profile / merchant account for subscriptions.
- [ ] RevenueCat account and project (iOS + Android apps, bundle / package
      `ai.klorn.app`).

## Phase 1 — Code items (resolved in the repo; one left for after the first upload)

Done on 2026-10-16 (paths under `apps/mobile/` unless noted):

- [x] **Push entitlement (iOS)**: `ios/App/App/App.entitlements`
      (`aps-environment` = development; the App Store / TestFlight export
      re-signs it as production) and `CODE_SIGN_ENTITLEMENTS = App/App.entitlements`
      on the App target's Debug and Release configurations
      (`ios/App/App.xcodeproj/project.pbxproj`). Background Modes → Remote
      notifications was already in `Info.plist`. Still yours: the App ID
      `ai.klorn.app` needs **Push Notifications** enabled in the Developer
      portal (Phase 2), or automatic signing fails on the capability.
- [x] **Privacy manifest in the target**: `ios/App/App/PrivacyInfo.xcprivacy`
      is in the App target's Resources phase (`project.pbxproj`) and declares
      the `privacy-labels.md` §2 types (Emails or Text Messages, User ID,
      Device ID, Product Interaction, Purchase History, plus Name, Email
      Address, Other User Content), all linked, none tracking.
- [x] **IAP keys in the release build**: `.github/workflows/mobile-release.yml`
      passes `VITE_REVENUECAT_IOS_KEY` / `VITE_REVENUECAT_ANDROID_KEY`
      (secret, else repository variable) to both "Build the app and sync"
      steps; documented in the workflow header and
      `docs/launch/mobile-store-setup.md` → "In-app purchase keys". Still
      yours: create the two secrets (Phase 2).
- [x] **Plans screen disclosures (3.1.2)**: title, length and price per period
      from the store package, the auto-renew sentence, how to cancel in the
      store's settings, Terms of Use + Privacy Policy links, Restore
      purchases (`src/screens/settings/PlansScreen.tsx`,
      `src/screens/settings/plans-model.ts`; 7 languages).
- [x] **Welcome copy**: `welcome.body` and the illustration chips list Gmail,
      a company Google Workspace, Naver (beta) and iCloud (beta) — no Outlook,
      no "one sign-in" (`src/screens/login/WelcomeScreen.tsx`,
      `src/i18n/locales/*.ts`).
- [x] **Store fixtures**: fictional third-party senders only, no Outlook
      account or calendar (`src/api/mock/`); see `screenshots-plan.md`
      "Check before you upload".
- [x] **Unused calendar plugin**: `@ebarooni/capacitor-calendar`, `probe/` and
      `KLORN_PROBE` are gone; `cap sync` regenerated
      `android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle`
      and `ios/App/CapApp-SPM/Package.swift` without it (no EventKit, no
      calendar usage string needed).
- [x] **Email sign-up**: Welcome → "Continue with email" → "create an account"
      (`POST /api/auth/register`; invite-only state from
      `GET /api/auth/signup-status`), so the app works without a third-party
      login. This does **not** satisfy 4.8 by itself — Sign in with Apple in
      production (Phase 2) still does.
- [x] Privacy hardening: `clearHidden()` runs in `src/auth/session.tsx`
      `wipe()` (sign-out, 401, account deletion); Android
      `android:allowBackup="false"` + `dataExtractionRules`
      (`android/app/src/main/AndroidManifest.xml`,
      `android/app/src/main/res/xml/data_extraction_rules.xml`).
- [ ] Android App Links: add the Play **app signing** SHA-256 to
      `website/.well-known/assetlinks.json` after the first Play upload
      (Phase 3).
- [x] The privacy-policy additions in `privacy-labels.md` §4: the live policy
      has a Mobile App section since 2026-10-17 (k08200/klorn#1473, #1489).

## Phase 2 — Signing, secrets and server env (≈1 h; `docs/launch/mobile-store-setup.md`)

iOS:

- [ ] App ID `ai.klorn.app` with Push Notifications (+ Sign in with Apple on
      the Services ID used by the web flow) and the App Store Connect app
      record (setup §1).
- [ ] App Store Connect API key → GitHub secrets `APPLE_TEAM_ID`,
      `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (setup §2).
- [ ] APNs key → Render `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
      `APNS_BUNDLE_ID=ai.klorn.app`, `APNS_PRODUCTION=true` (TestFlight and
      the App Store use production APNs) (setup §3).
- [ ] **Sign in with Apple in production** (needed for Guideline 4.8 because
      Google sign-in is offered): Render `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`,
      `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_REDIRECT_URI`, then
      `APPLE_LOGIN_ENABLED=true`. The app shows the Apple button by itself
      once `GET /api/auth/providers` lists it.

Android:

- [ ] Upload keystore → `ANDROID_KEYSTORE_BASE64`,
      `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
      `ANDROID_KEY_PASSWORD` (setup §2).
- [ ] Firebase Android app `ai.klorn.app` → `ANDROID_GOOGLE_SERVICES_JSON_BASE64`;
      Render `FIREBASE_SERVICE_ACCOUNT` (setup §5). Without it the build works
      but Android has no push.
- [ ] Play service account → `PLAY_SERVICE_ACCOUNT_JSON` (setup §3).

Purchases (both):

- [ ] App Store Connect: an auto-renewable subscription group with the Pro
      product(s); Play Console: the matching subscription + base plan.
- [ ] RevenueCat: import both products, one entitlement, a **current
      offering** whose first package is what "Subscribe" buys
      (`src/platform/iap.ts` takes `offerings.current.availablePackages[0]`).
- [ ] RevenueCat webhook → `https://api.klorn.ai/api/webhook/revenuecat`
      with an Authorization value; the same value as Render
      `REVENUECAT_WEBHOOK_AUTH`.
- [ ] RevenueCat public SDK keys → GitHub secrets (or variables)
      `VITE_REVENUECAT_IOS_KEY` / `VITE_REVENUECAT_ANDROID_KEY`
      (`docs/launch/mobile-store-setup.md` → "In-app purchase keys"). Without
      them the release build ships with IAP off.

## Phase 3 — First release build (≈30 min + processing)

- [ ] `git tag mobile-v1.0.0 && git push origin mobile-v1.0.0`.
- [ ] iOS: the run uploads to TestFlight; wait for "processing completed".
      `ITSAppUsesNonExemptEncryption=false` answers export compliance.
- [ ] Android: download the `klorn-android-release` artifact and upload the
      `.aab` **once by hand** (Play Console → Testing → Internal testing →
      Create release) — Google's rule for a new app. Later tags upload
      themselves. Then: Play Console → Setup → App integrity → copy the **app
      signing** key SHA-256 into `website/.well-known/assetlinks.json` (it
      holds one fingerprint today; add the Play one) so verified App Links
      work for the release build.

## Phase 4 — Device pass (≈1 h; the only end-to-end test of a signed build)

On a real iPhone (TestFlight) and a real Android phone (internal track),
ideally also an iPad and a Galaxy Fold / Flip:

- [ ] Sign in with Google, Apple and email, and create an account with email
      (Welcome → Continue with email → create an account); relaunch
      (Keychain / Keystore session survives); sign out (cache and token gone).
- [ ] Push: priming → OS prompt → send yourself a PUSH-lane mail → a visible
      notification with the app closed → tap opens that message. Foreground
      banner while the app is open. iOS: long-press → In 1 hour / Done act on
      that mail (category `KLORN_PUSH_MAIL`).
- [ ] Plans (sandbox): the offer card shows the product title, length and
      price per period; auto-renew and cancel text; Terms / Privacy links open
      the browser.
- [ ] Mail: swipe right (Done, undo), swipe left (lane sheet), long-press
      select; open a mail, links open in the system browser, an attachment
      opens in the share sheet; Edit draft → Review & send → receipt.
- [ ] Airplane mode cold start: cached Today with the offline banner.
- [ ] Plans: sandbox purchase → plan becomes Pro within a minute → Restore →
      Manage opens the store page.
- [ ] Settings › Delete account on a throwaway account: account gone, app back
      at Welcome.
- [ ] Android back: sheet → detail → previous tab → background. Fold flat /
      half-folded / rotated, Flip cover, iPad Split View and Stage Manager,
      Dynamic Type large sizes.
- [ ] If anything fails: fix → new tag (`mobile-v1.0.1`) → repeat.

The full list lives in `apps/mobile/README.md` → "Verify on device / CI".

## Phase 5 — Listings (≈2 h; can start any time after Phase 0)

- [ ] Demo account per `review-notes.md` §1 (demo Gmail seeded and linked).
- [x] Screenshots (KO + EN at every upload size), the Play feature graphic
      (1024×500, KO + EN) and the 512×512 icon: GitHub → Actions → **Mobile
      Store Assets** → Run workflow → artifact `klorn-store-assets`
      (`store-pack/capture/`; locally `npx playwright test --config
      store-pack/capture/playwright.store.config.ts`). Upload them.
- [ ] App Store Connect: name, subtitle, promo text, description, keywords,
      URLs, category, age rating from `metadata.md` (EN + KO); App Privacy from
      `privacy-labels.md` §2; App Review Information from `review-notes.md` §2;
      price **Free**; the subscription's own metadata, review screenshot and
      localized names; attach the subscription to version 1.0.
- [ ] Play Console: store listing from `metadata.md` (EN + KO); App content —
      privacy policy `https://klorn.ai/privacy/`, App access
      (`review-notes.md` §3), Ads: none, Content rating, Target audience 18+,
      Data safety (`privacy-labels.md` §3); countries; free app with
      subscriptions.
- [x] Privacy policy updated per `privacy-labels.md` §4 (done 2026-10-17).

## Phase 6 — Submit

- [ ] App Store: version 1.0 → the tested build → **Manually release** after
      approval (recommended) → **Add for Review** → **Submit**. Keep the
      contact phone reachable.
- [ ] Play: promote the tested release from internal → closed (12 testers ×
      14 days, if your account needs it) → production → **Send for review**.
- [ ] Open the demo account the day you submit.

## Phase 7 — After the verdict

- **Approved** → release → install from the store and repeat the Phase 4
  smoke test → rotate the demo password.
- **Rejected** → read the message; likely ones and the prepared answers:
  - **4.8** → Sign in with Apple not visible: `APPLE_LOGIN_ENABLED` off.
  - **3.1.2** → point to Settings › Plans: length, price per period,
    auto-renew and cancel text, Terms / Privacy links sit next to Subscribe
    (if the product's own metadata is missing, fix it in App Store Connect).
  - **2.1** → demo account empty or Gmail link expired: refresh, reply in
    Resolution Center (no new build needed).
  - **4.2** → reply with the "Native functionality" block of
    `review-notes.md` §2 and the demo video.
  - **5.1.1(v)** → point to Settings › Delete account (path in the notes).
