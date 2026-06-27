import type { CapacitorConfig } from "@capacitor/cli";

// Two run modes (see apps/mobile/README.md):
//
//  • PROBE (default) — loads the bundled www/ Samsung-calendar probe. No
//    backend, login, or Firebase needed. `npx cap run android` tests whether
//    Samsung Calendar surfaces via the standard provider, immediately.
//
//  • SHELL (product) — loads the hosted web app (app.klorn.ai), which carries
//    all native-aware JS guarded by Capacitor.isNativePlatform(). Enable once
//    packages/web is deployed with the native code:
//        KLORN_SHELL=1 npx cap sync && npx cap run android
//
// Env-driven so there is no config to hand-edit when switching.
const shell = process.env.KLORN_SHELL === "1";

const config: CapacitorConfig = {
  appId: "ai.klorn.app",
  appName: "Klorn",
  webDir: "www",
  ...(shell
    ? {
        server: {
          url: "https://app.klorn.ai",
          // https so localStorage / secure-context behave as on the real site.
          androidScheme: "https",
          // Only the app's own origin stays in the WebView — API calls are XHR,
          // and Google OAuth must open in the system browser (RFC 8252).
          allowNavigation: ["app.klorn.ai"],
        },
      }
    : {}),
};

export default config;
