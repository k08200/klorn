# Klorn — App Store + Play Store submission checklist

Capacitor shell (`ai.klorn.app`) wrapping the hosted web app (`app.klorn.ai`).
This is the source of truth for getting Klorn onto both stores. Items are split
into **[CODE — done]** (already in the repo), **[CODE — remaining]**, and
**[YOU — founder-ops]** (accounts, consoles, secrets, signing — cannot be done
in code).

---

## ✅ [CODE — done] (this repo)

- **SHELL is the default build.** `capacitor.config.ts` now loads `app.klorn.ai`
  by default; the throwaway Samsung-calendar probe is opt-in only
  (`KLORN_PROBE=1 npx cap sync`). A plain `npx cap sync` can no longer ship the
  probe screen. **Store builds must NOT set `KLORN_PROBE`.**
- **Calendar permission prompt removed.** The on-device calendar probe (which
  asked for calendar access then only logged) is no longer called on native
  launch — it was an App Store **5.1.1** risk (permission with no feature). The
  matching `NSCalendars*` usage strings were removed from `Info.plist`.
- **Export compliance answered in-binary.** `ITSAppUsesNonExemptEncryption=false`
  in `Info.plist` (standard HTTPS only) — removes the manual prompt on every
  upload.
- **iOS Privacy Manifest added** (`ios/App/App/PrivacyInfo.xcprivacy`) — backs
  the App Privacy label and declares the Required-Reason API (UserDefaults).
  ⚠️ You must add it to the App target in Xcode (see below).
- **Versions aligned** — `package.json` 1.0.0; iOS `MARKETING_VERSION` 1.0 /
  build 1; Android `versionName` 1.0 / `versionCode` 1.
- **Native identity & wiring already in place** (pre-existing): bundle id
  `ai.klorn.app` on all four surfaces; icons + splash for both platforms;
  native Google sign-in via system browser (RFC 8252); APNs token forwarding
  (`AppDelegate.swift`) + backend `push-apns.ts`; OAuth deep-link scheme
  registered on both platforms; Android permissions minimal (INTERNET,
  POST_NOTIFICATIONS).

## [CODE — remaining] (small, mostly needs your accounts first)

- **iOS `.entitlements`** (`aps-environment`, and optionally `associated-domains`
  for App Links / Sign in with Apple) — created automatically when you add the
  **Push Notifications** + **Background Modes** capabilities in Xcode. Needs your
  Apple team/signing, so it's the first Xcode step below (not hand-editable
  safely without signing).
- **Android App Links `autoVerify` + `assetlinks.json`** — hardens the OAuth
  relay against custom-scheme hijacking. Follow-up, not a submission blocker.
- **Native calendar (Samsung + Google) feature** — currently only a diagnostic
  probe existed (removed). The web app already shows Google Calendar; on-device
  (Samsung) calendar is a fast-follow. Ship v1 without it, or build it first if
  you want it as a launch differentiator (helps the Apple 4.2 case — see below).

---

## ⚠️ Apple 4.2 "thin web-wrapper" risk — read this

A WebView over `app.klorn.ai` is exactly the profile Apple rejects under 4.2
unless genuinely-native behavior is live at first launch. Today the only clearly
native first-session behavior is the system-browser Google sign-in. **To de-risk
before submitting, native push must actually deliver a visible notification**
(needs the iOS entitlement + APNs key + FCM below). With live push + native
sign-in demonstrable at launch, the app moves from "thin wrapper" to defensible.

---

## 🔑 [YOU — founder-ops] — ordered

### A. Apple (iOS)
1. **Apple Developer Program** membership ($99/yr). Then in Xcode: open
   `ios/App/App.xcworkspace` → select the *App* target → **Signing & Capabilities**
   → set your Team (this writes `DEVELOPMENT_TEAM`, currently absent).
2. **Add capabilities** (same screen): **Push Notifications** and **Background
   Modes → Remote notifications**. This creates the `.entitlements` file with
   `aps-environment`. (Optional now: **Associated Domains**, **Sign in with
   Apple** — see 4.8 note.)
3. **Add `PrivacyInfo.xcprivacy` to the target**: in Xcode's Project Navigator,
   right-click the `App` group → *Add Files…* → select the file → check the
   *App* target. (The file already exists in the repo; it just needs target
   membership so it's copied into the bundle.)
4. **APNs Auth Key (.p8)** in the Apple Developer portal (Keys → +, enable APNs).
   Put it + IDs on Render: `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID=ai.klorn.app`, `APNS_PRODUCTION=true`. Ensure the App ID
   `ai.klorn.app` has **Push** enabled. (See `apps/mobile/README.md`.)
5. **App Store Connect** app record: listing, description, category, age rating,
   privacy policy URL, and the **App Privacy** questionnaire (must match
   `PrivacyInfo.xcprivacy`).
6. **Screenshots** for all required device sizes.
7. **Apple 4.8 (Sign in with Apple)**: since Google sign-in is offered, Apple may
   require Sign in with Apple. Check current guidance; if required it's a code
   add (new auth provider) — flag me and I'll wire it.

### B. Google (Android)
1. **Firebase project** → Android app `ai.klorn.app` → download
   `google-services.json` into `apps/mobile/android/app/`. Put
   `FIREBASE_SERVICE_ACCOUNT` on Render (Android FCM send path).
2. **Play Console** app record: listing, **Data safety** form, content rating,
   privacy policy URL, target audience.
3. **Upload keystore** (app signing) for the Play release.
4. **Screenshots** + feature graphic.

### C. Payments (required by both stores)
- **RevenueCat** account + products: App Store subscriptions + Play Billing
  products. Set `NEXT_PUBLIC_REVENUECAT_IOS_KEY` / `_ANDROID_KEY` on the web
  build. Apple/Google forbid selling the subscription via Stripe inside the app,
  so IAP must be live before charging in-app. (IAP code is already wired but
  inert without these keys.)

### D. Google OAuth / Gmail scopes
- **CASA Tier 2 / OAuth verification** for the restricted Gmail scopes is
  required before public store distribution of Google sign-in. This is the
  standing verification item — start it early, it takes weeks.

### E. Deploy + activate
- Ensure `packages/web` (with the native login/push code) is deployed to
  `app.klorn.ai` — the shell loads that site. Optionally set
  `NEXT_PUBLIC_NATIVE_OAUTH_SCHEME=ai.klorn.app` to activate the OAuth deep-link
  relay (do a **real-device smoke test** first — `apps/mobile/OAUTH_RELAY.md`).

---

## Build commands (once signing + secrets are in)

```bash
cd apps/mobile
npm install
npm run sync            # SHELL (product) — the default
npm run open:ios        # archive + upload via Xcode / Transporter
npm run open:android    # build App Bundle (.aab) → Play Console
# diagnostics only, never for the store:
npm run sync:probe      # KLORN_PROBE=1 — Samsung calendar probe
```
