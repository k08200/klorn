# Native OAuth deep-link relay (login-CSRF fix)

The desktop/native Google login used a **nonce-poll** flow: the server parked the
session JWT keyed on a nonce, and the app polled `/desktop-token/:nonce` to get
it. That is vulnerable to **login-CSRF** — an attacker mints their own nonce,
phishes the victim into completing Google OAuth against it, then polls and steals
the victim's JWT. PKCE alone cannot stop this (the attacker holds their own
verifier).

The **relay** fixes it fundamentally: the server redirects the browser to a
custom app scheme `ai.klorn.app://oauth-callback?code=<one-time>`, which the OS
delivers **only to the Klorn app on the device that completed OAuth**. A remote
attacker who only knows a nonce has no channel to receive that deep link. The
app then exchanges the one-time code via `POST /api/auth/exchange-code`.

## Status

- **Server + web client: shipped and verified** (`packages/api/src/routes/auth.ts`,
  `packages/web/src/lib/native/native-auth.ts`).
- **Currently dormant.** `startNativeGoogleLogin()` uses the relay only when
  `NEXT_PUBLIC_NATIVE_OAUTH_SCHEME` is set; otherwise it stays on the PKCE-poll
  fallback. The steps below activate it. Do a device smoke test before flipping
  it in production.

## Activation

### 1. Register the custom scheme natively

**Android** — in `apps/mobile/android/app/src/main/AndroidManifest.xml`, inside
the main `<activity>`:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="ai.klorn.app" android:host="oauth-callback" />
</intent-filter>
```

**iOS** — in `apps/mobile/ios/App/App/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>ai.klorn.app.oauth</string>
    <key>CFBundleURLSchemes</key>
    <array><string>ai.klorn.app</string></array>
  </dict>
</array>
```

Then `npx cap sync`.

### 2. Set the client env

In the web build (Vercel) env for the native/SHELL build:

```
NEXT_PUBLIC_NATIVE_OAUTH_SCHEME=ai.klorn.app
```

If you register a different scheme, also set the server allowlist
`NATIVE_OAUTH_SCHEMES` (default `ai.klorn.app,klorn`) so the callback accepts it.

### 3. Device smoke test

Sign in with Google on a real iOS device and a real Android device. Confirm the
system browser hands back to the app (`appUrlOpen` fires) and the app lands on
`/inbox`. If the deep link never arrives, the relay times out after 3 min — the
scheme registration is wrong or missing.

## Residual hardening (follow-up)

Custom schemes can be **hijacked** by a malicious co-resident app that registers
the same scheme (Android in particular). To harden, migrate to verified
**Android App Links** (`assetlinks.json`) / **iOS Universal Links**
(`apple-app-site-association`) bound to `app.klorn.ai`, and relay to
`https://app.klorn.ai/oauth-callback?code=…` instead of the custom scheme. This
is a device-local threat, not login-CSRF, and does not block the relay.
