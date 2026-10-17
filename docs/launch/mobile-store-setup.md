# Mobile store setup — the founder's part (iOS App Store + Google Play)

The code side (the app, CI, signing and upload workflows) is in this repo.
Everything below needs your Apple / Google accounts and can only be done by you.
Do it in this order; each step says what to paste where. When a step is done,
the `Mobile Release` workflow picks it up on the next `mobile-v*` tag.

Where secrets go: GitHub → k08200/klorn → Settings → Secrets and variables →
Actions → **New repository secret**. Names must match exactly.

---

## iOS (App Store)

### 1. App ID and app record (~10 min)

1. https://developer.apple.com/account → **Certificates, Identifiers & Profiles**
   → Identifiers → check that **`ai.klorn.app`** exists (App IDs). If not: `+` →
   App IDs → App → Bundle ID *Explicit* `ai.klorn.app`. Enable **Push
   Notifications** and **Sign in with Apple**. Save.
2. https://appstoreconnect.apple.com → My Apps → `+` → **New App**:
   platform iOS, name **Klorn**, primary language Korean or English,
   bundle id `ai.klorn.app`, SKU `klorn-ios`, access *Full*.

### 2. App Store Connect API key (~5 min) → 4 GitHub secrets

1. App Store Connect → **Users and Access** → **Integrations** → **App Store
   Connect API** → Team Keys → `+` → name `GitHub CI`, access **App Manager**
   (Admin also works) → Generate.
2. Download the `.p8` file (it can be downloaded only once). Note the **Key ID**
   and the **Issuer ID** shown above the list.
3. Your **Team ID**: developer.apple.com/account → Membership details.
4. GitHub secrets:

| Secret | Value |
|---|---|
| `APPLE_TEAM_ID` | the 10-character Team ID |
| `ASC_KEY_ID` | Key ID |
| `ASC_ISSUER_ID` | Issuer ID |
| `ASC_KEY_P8_BASE64` | `base64 -i AuthKey_XXXX.p8 \| pbcopy` on a Mac, then paste |

### 3. Push (APNs) for the API (~5 min)

developer.apple.com → Keys → `+` → enable **Apple Push Notifications service
(APNs)** → download the `.p8`. On Render (`klorn-api` → Environment):
`APNS_KEY_P8` (file contents), `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_BUNDLE_ID=ai.klorn.app`, `APNS_PRODUCTION=true`.

### 4. Store listing (~1 h, can wait until the first TestFlight build works)

App Store Connect → the app → fill from `apps/mobile/store-pack/metadata.md`,
privacy answers from `apps/mobile/store-pack/privacy-labels.md`, store-size
screenshots rendered by `npx playwright test --config
store-pack/capture/playwright.store.config.ts` in `apps/mobile` (sizes and
captions in `store-pack/screenshots-plan.md`; the CI `mobile-screenshots`
artifact is device-scale review shots, not upload sizes), demo account per `apps/mobile/store-pack/review-notes.md`. Then **Add for
Review** → **Submit**.

---

## Android (Google Play)

### 1. Play Console app (~15 min)

https://play.google.com/console → **Create app** → name Klorn, app, free.
Complete the dashboard's *Set up your app* tasks (privacy policy URL
`https://klorn.ai/privacy/`, app access with the demo account, ads: no,
content rating, target audience, data safety per `privacy-labels.md`).

### 2. Upload keystore (~5 min, on any machine with Java) → 4 GitHub secrets

```bash
keytool -genkeypair -v -keystore klorn-upload.jks -alias klorn-upload \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -i klorn-upload.jks | pbcopy   # macOS; Linux: base64 -w0 klorn-upload.jks
```

Keep `klorn-upload.jks` and its passwords somewhere safe (a password manager).

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the base64 output |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `klorn-upload` |
| `ANDROID_KEY_PASSWORD` | key password |

### 3. Service account for uploads (~10 min) → 1 GitHub secret

1. Google Cloud console (any project you own) → IAM → Service accounts → Create
   → no roles → Keys → Add key → JSON → download.
2. Play Console → **Users and permissions** → Invite new users → the service
   account's email → app permissions for Klorn: *Release to testing tracks*
   and *Manage testing tracks* (or *Release manager*).
3. GitHub secret `PLAY_SERVICE_ACCOUNT_JSON` = the whole JSON file contents.

### 4. The first upload is manual (Google's rule)

Download the `klorn-android-release` artifact from the first `Mobile Release`
run (or run `./gradlew bundleRelease` locally with the keystore) and upload the
`.aab` once in Play Console → Testing → Internal testing → Create release.
Every later release is uploaded by the workflow.

### 5. Push (FCM) for Android

Firebase console → project → add Android app `ai.klorn.app` → download
`google-services.json` → GitHub secret `ANDROID_GOOGLE_SERVICES_JSON_BASE64`
(base64 of the file). Firebase → Project settings → Service accounts →
Generate key → Render env `FIREBASE_SERVICE_ACCOUNT` (whole JSON).

Optional, later: Android notification buttons (In 1 hour · Done · Review).
The app posts them itself from FCM data-only messages, which the server sends
only while Render env `ANDROID_DATA_PUSH_ENABLED=true` (OFF by default; needs
the `20261017010000_device_push_data_messages` migration, which `start.sh`
applies). Only devices on a build that registered `dataMessages: true` are
switched; everyone else keeps today's notification messages. Turn it on after
checking on one real Android phone that a mail push shows the three buttons
with the app closed.

---

## In-app purchase keys (both platforms) → 2 GitHub secrets

RevenueCat → Project → **API keys** → the public SDK key of each app. They are
read when the release workflow runs `npm run build` (`mobile-release.yml`,
"Build the app and sync" steps):

| Secret | Value |
|---|---|
| `VITE_REVENUECAT_IOS_KEY` | the iOS app's public SDK key (`appl_…`) |
| `VITE_REVENUECAT_ANDROID_KEY` | the Android app's public SDK key (`goog_…`) |

They are public keys, so a repository **variable** with the same name works
too (a secret wins when both exist). Unset or empty = that platform's build
ships with in-app purchase **off** (the run prints a notice): Plans shows the
plan only and offers nothing to buy — then also leave Purchase History out of
the App Privacy / Data safety answers for that build
(`apps/mobile/store-pack/privacy-labels.md`).

---

## Releasing

```bash
git tag mobile-v1.0.0 && git push origin mobile-v1.0.0
```

The run uploads to TestFlight and the Play internal track. Testers install from
TestFlight / the Play internal-testing link; when it looks right, submit for
review from each console (App Store: the build → Submit for Review; Play:
promote internal → production).
