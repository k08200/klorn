import type { CapacitorConfig } from "@capacitor/cli";

// Two run modes (see apps/mobile/README.md):
//
//  • SHELL (default, product) — loads the hosted web app (app.klorn.ai), which
//    carries all native-aware JS guarded by Capacitor.isNativePlatform(). This
//    is what store builds MUST ship, so it is the default: a plain
//    `npx cap sync` can never accidentally package the throwaway probe.
//
//  • PROBE (opt-in) — loads the bundled www/ Samsung-calendar diagnostic. No
//    backend, login, or Firebase needed. Only for local device testing:
//        KLORN_PROBE=1 npx cap sync && npx cap run android
//
// Env-driven so there is no config to hand-edit when switching.
const probe = process.env.KLORN_PROBE === "1";
const shell = !probe;

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
