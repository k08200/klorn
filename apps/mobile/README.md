# Klorn Mobile (Capacitor shell)

Native Android + iOS app for Klorn. Two run modes share one project:

- **PROBE (default)** — a self-contained on-device test (`www/index.html`) that
  lists every calendar the device exposes. It answers the one make-or-break
  question — **does Samsung Calendar surface via the standard Android provider?**
  — with **no backend, no login, no Firebase**. Run this first.
- **SHELL (product)** — loads the hosted web app (`https://app.klorn.ai`) and
  adds native push (FCM) + on-device calendar. All native-aware JS lives in
  `packages/web/src/lib/native/`, guarded by `Capacitor.isNativePlatform()`.

> **Standalone package** — NOT in the pnpm workspace. Use **npm** here (like
> `apps/desktop-mac`). The `android/` project IS committed (it carries our
> manifest permissions); run `npx cap sync` after cloning to populate web assets.

---

## Fastest: sideload the prebuilt probe APK (no Android Studio)

A debug APK of the probe is already built at
`apps/mobile/klorn-probe-debug.apk` (package `ai.klorn.app`, ~5.6 MB).

1. Copy `klorn-probe-debug.apk` to the Galaxy (USB file transfer, Google Drive,
   or message it to yourself).
2. On the phone, open the file → allow **"Install unknown apps"** for the app
   you opened it from → **Install**.
3. Open **Klorn** → **Read device calendars** → grant the permission → read the
   list. A **SAMSUNG?**-tagged calendar means the on-device path works.

   (With `adb` installed: `adb install apps/mobile/klorn-probe-debug.apk`.)

Rebuild it yourself with: `cd android && JAVA_HOME=<JDK 21> ./gradlew assembleDebug`
→ `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## Prerequisites (one-time, for building/iterating)

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

## Run the Samsung probe (do this first)

```bash
cd apps/mobile
npm install
npx cap sync android          # android/ is committed; this repopulates web assets
npx cap run android           # pick your Galaxy from the list
#   or: npx cap open android  → press Run (▶) in Android Studio
```

On the phone: tap **Read device calendars**, grant the permission, and read the
list. A calendar tagged **SAMSUNG?** means the on-device path works.

- ✅ Samsung calendar appears → Phase 3 (on-device calendar UI) is viable.
- ❌ no Samsung calendar → it isn't exposed via the standard provider; fall back
  to Google Calendar only (already supported server-side).

No Firebase is needed for the probe — the push plugin only activates FCM when a
`google-services.json` is present (`android/app/build.gradle` applies it
conditionally).

---

## Run the full shell (after packages/web is deployed)

The shell loads `https://app.klorn.ai`, so the native web code in `packages/web`
must be **deployed** there first (it's additive and guarded — safe on web).

```bash
KLORN_SHELL=1 npx cap sync android
KLORN_SHELL=1 npx cap run android
```

`KLORN_SHELL=1` flips `capacitor.config.ts` to load the hosted URL instead of the
local probe bundle.

### Enable native push (FCM)

1. Firebase console → add an **Android app** with package name **`ai.klorn.app`**.
2. Download **`google-services.json`** → `apps/mobile/android/app/` (gitignored).
3. Firebase → Project settings → Service accounts → generate a key; set it on the
   API (Render) as `FIREBASE_SERVICE_ACCOUNT` (the full JSON as one string).
4. `npx cap sync android` and rebuild.
5. In the app, sign in, then `POST /api/notifications/push/device-test` rings the phone.

For iOS later: also upload an APNs auth key (.p8) to Firebase + `npx cap add ios`.

---

## iOS — full guide (build on a Mac with Xcode)

iOS needs **no Firebase** — push goes straight to APNs. The `ios/` project is
generated and committed with everything pre-wired that can be (Info.plist usage
strings, `UIBackgroundModes`, and the AppDelegate APNs forwarding). **It can only
be built on a Mac with Xcode** (signing requires it — no headless/sideload path
like Android's APK). Capacitor 8 uses **Swift Package Manager**, so no CocoaPods.

Do it in two stages.

### Stage A — smoke test on iPhone (no deploy, no keys, no Apple paid account)

Default config is PROBE mode: the app loads the bundled probe page and reads the
device calendar via EventKit. Confirms the app builds + runs on your iPhone and
the calendar plugin works — before any backend/keys.

```bash
cd apps/mobile
npm install
npx cap sync ios
npx cap open ios          # Xcode opens
```
In Xcode: **App** target → **Signing & Capabilities** → set **Team** (a free
personal Apple ID works for device testing) → connect iPhone → **Run (▶)**.
Tap **Read device calendars**, grant access, see your iCloud/Google calendars.

### Stage B — full app (shell + login + push)

1. **Deploy `packages/web`** (with the native code on this branch) to
   `app.klorn.ai` so the shell loads a site that has the native login/push/calendar.
2. **APNs key** (Apple Developer, paid): create an **APNs Auth Key (.p8)**, note
   the **Key ID** + **Team ID**. Ensure the App ID is **`ai.klorn.app`** with
   Push enabled. Set on the API (Render):
   ```
   APNS_KEY_P8=<.p8 contents>   APNS_KEY_ID=…   APNS_TEAM_ID=…
   APNS_BUNDLE_ID=ai.klorn.app  APNS_PRODUCTION=false   # sandbox for Xcode debug builds
   ```
3. In Xcode → **Signing & Capabilities** → **+ Capability** → add **Push
   Notifications** and **Background Modes → Remote notifications**. (The
   AppDelegate forwarding is already in code; this step wires the entitlement,
   which needs your signing.)
4. Build in SHELL mode and run:
   ```bash
   KLORN_SHELL=1 npx cap sync ios
   npx cap open ios   # Run (▶)
   ```
   Sign in (system browser), then a PUSH-tier interrupt (or the device-test
   route) rings the iPhone.

What works on iOS once Stage B is done: app shell, on-device calendar (EventKit),
Google sign-in (system browser), and native push (APNs).

### iOS push (implemented — provide an APNs key to activate)

`@capacitor/push-notifications` returns an **APNs token** on iOS (not an FCM
token), so iOS delivery goes **straight to APNs** (`packages/api/src/push-apns.ts`,
HTTP/2 + an ES256 provider JWT) rather than through FCM. This was the chosen path
(over unified `@capacitor-firebase/messaging`) because it keeps the Android probe
Firebase-free and the web bundle lean. Both channels run after the same gates in
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

## What maps where

| Capability | Web module (in the WebView, SHELL mode) | Native plugin |
|---|---|---|
| Sign-in | `packages/web/src/lib/native/native-auth.ts` | `@capacitor/browser` |
| Push token | `packages/web/src/lib/native/native-push.ts` | `@capacitor/push-notifications` |
| Calendar | `packages/web/src/lib/native/calendar-probe.ts` | `@ebarooni/capacitor-calendar` |
| Detection | `packages/web/src/lib/native/capacitor.ts` | injected `window.Capacitor` |

Manifest permissions already set in `android/app/src/main/AndroidManifest.xml`:
`READ_CALENDAR`, `POST_NOTIFICATIONS`.
