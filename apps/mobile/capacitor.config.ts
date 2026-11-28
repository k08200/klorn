import type { CapacitorConfig } from "@capacitor/cli";
import type { KeyboardResize } from "@capacitor/keyboard";

// Klorn mobile is a BUNDLED app: the React SPA in src/ is built by Vite into
// dist/ and copied into the native projects by `cap sync`. It talks to the
// Klorn API directly — there is no `server.url`, so nothing loads from
// app.klorn.ai and the app renders its own offline state when the network is
// down (src/ui/StateView.tsx). Run `npm run build` before `npx cap sync`
// (`npm run sync` does both).
//
// Shell build (opt-in, PR6a of the Structure A move): KLORN_MOBILE_SHELL=1
// swaps webDir for web-export/, the packages/web static export copied by
// `npm run build:shell` (scripts/build-shell-web.mjs; `npm run sync:shell`
// does both). The native routers (android shell/ShellWebViewClient.java, ios
// ShellBridgeViewController.swift) serve its per-route files and dynamic-route
// shells from shell-routes.json; with dist/ they behave as Capacitor's own.
const SHELL_BUILD = process.env.KLORN_MOBILE_SHELL === "1";

const config: CapacitorConfig = {
  appId: "ai.klorn.app",
  appName: "Klorn",
  webDir: SHELL_BUILD ? "web-export" : "dist",
  server: {
    // https so secure-context APIs (crypto.subtle for PKCE) behave as on the
    // web. The bundle is served from https://localhost (Android) and
    // capacitor://localhost (iOS); no remote origin is ever navigated to.
    androidScheme: "https",
  },
  plugins: {
    // API calls go through native HTTP: window.fetch is patched on native, so
    // the bundled origin never meets CORS and no Origin allowlist entry is
    // needed on the API. In the browser (dev, tests) plain fetch is used.
    CapacitorHttp: { enabled: true },
    // Android edge-to-edge: inject --safe-area-inset-* CSS variables with the
    // real system-bar/cutout insets (env(safe-area-inset-*) is unreliable in
    // the Android WebView). iOS fills env() itself.
    SystemBars: { insetsHandling: "css" },
    SplashScreen: {
      // The app hides it as soon as its first real frame is up (src/app/App.tsx);
      // the auto-hide is only a backstop so a failed bundle never sticks on it.
      launchAutoHide: true,
      launchShowDuration: 3000,
      backgroundColor: "#fafafa",
    },
    PushNotifications: {
      // In the foreground the app shows its own banner (src/push/PushLayer.tsx);
      // the OS banner would duplicate it.
      presentationOptions: ["badge"],
    },
    Keyboard: {
      // Resize the body, so composers and their buttons ride above the
      // keyboard (canvas notes.gestures).
      resize: "body" as KeyboardResize,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
