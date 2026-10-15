import type { CapacitorConfig } from "@capacitor/cli";

// Two run modes (see apps/mobile/README.md):
//
//  • SHELL (default, product) — loads the hosted web app (app.klorn.ai), which
//    carries all native-aware JS guarded by Capacitor.isNativePlatform(). This
//    is what store builds MUST ship, so it is the default: a plain
//    `npx cap sync` can never accidentally package the throwaway probe.
//
//    Its bundled web dir (www/) holds only the offline / load-failure page,
//    shown via `server.errorPath` when app.klorn.ai cannot be reached.
//
//  • PROBE (opt-in) — loads the bundled probe/ Samsung-calendar diagnostic.
//    No backend, login, or Firebase needed. Only for local device testing:
//        KLORN_PROBE=1 npx cap sync && npx cap run android
//    The probe lives in its own web dir, so a store build (www/) can never
//    contain it.
//
// Env-driven so there is no config to hand-edit when switching.
const probe = process.env.KLORN_PROBE === "1";
const shell = !probe;

const config: CapacitorConfig = {
  appId: "ai.klorn.app",
  appName: "Klorn",
  webDir: shell ? "www" : "probe",
  ...(shell
    ? {
        server: {
          url: "https://app.klorn.ai",
          // https so localStorage / secure-context behave as on the real site.
          androidScheme: "https",
          // Only the app's own origin stays in the WebView — API calls are XHR,
          // and Google OAuth must open in the system browser (RFC 8252).
          allowNavigation: ["app.klorn.ai"],
          // A failed main-frame load (offline, DNS, TLS, HTTP error) shows the
          // bundled www/index.html instead of a blank WebView; its Retry goes
          // back to `url` above (keep the two in sync).
          errorPath: "index.html",
        },
      }
    : {}),
};

export default config;
