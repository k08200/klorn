"use client";

// The Capacitor shell's app-wide native wiring (Structure A) — parity with
// apps/mobile/src/app/App.tsx and platform/{back-button,keyboard,link-relay}.ts:
//   - hide the splash screen once the web app has rendered;
//   - Android back: close the open sheet/dialog → history back → home → leave;
//   - the keyboard height for fixed sheets (./keyboard.ts);
//   - `ai.klorn.app://link-complete?h=…`: an account link that finished in the
//     system browser comes back here and is completed with this app's session
//     by the existing /link/complete page.
// Loaded only inside the shell (components/native-bridge-mount.tsx).

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { landingHome } from "../home";
import { browserSessionStorage, storePendingHandle } from "../link-complete";
import { decideBack } from "./back-decision";
import { nativePlatform } from "./capacitor";
import { NATIVE_OAUTH_SCHEME, parseLinkComplete } from "./deep-links";
import { installNativeKeyboard } from "./keyboard";

const SPLASH_FADE_MS = 160;
const OPEN_DIALOG = '[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]';

/** Ask the topmost open sheet or dialog to close the way a keyboard user would. */
function closeTopDialog(): void {
  const dialogs = document.querySelectorAll<HTMLElement>(OPEN_DIALOG);
  const top = dialogs[dialogs.length - 1];
  const target = top ?? document.activeElement ?? document.body;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

type Listener = { remove: () => Promise<void> };

/** Add a Capacitor listener; the returned cleanup also covers an add that settles late. */
function track(add: Promise<Listener>): () => void {
  let alive = true;
  let handle: Listener | null = null;
  add
    .then((h) => {
      if (alive) handle = h;
      else void h.remove();
    })
    .catch((err) => console.warn("[NATIVE] listener failed:", err));
  return () => {
    alive = false;
    void handle?.remove();
  };
}

export default function NativeBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const live = useRef({ router, pathname });
  live.current = { router, pathname };

  // Splash: the web app has rendered.
  useEffect(() => {
    void import("@capacitor/splash-screen")
      .then(({ SplashScreen }) => SplashScreen.hide({ fadeOutDuration: SPLASH_FADE_MS }))
      .catch((err) => console.warn("[NATIVE] splash hide failed:", err));
  }, []);

  useEffect(() => {
    let uninstall: (() => void) | null = null;
    let alive = true;
    void installNativeKeyboard().then((u) => {
      if (alive) uninstall = u;
      else u();
    });
    return () => {
      alive = false;
      uninstall?.();
    };
  }, []);

  // Android back. With a listener registered Capacitor no longer navigates the
  // WebView itself, so the app owns back completely.
  useEffect(() => {
    if (nativePlatform() !== "android") return;
    return track(
      import("@capacitor/app").then(({ App }) =>
        App.addListener("backButton", ({ canGoBack }) => {
          const action = decideBack({
            dialogOpen: document.querySelector(OPEN_DIALOG) !== null,
            pathname: live.current.pathname ?? window.location.pathname,
            canGoBack,
          });
          if (action.kind === "closeDialog") closeTopDialog();
          else if (action.kind === "historyBack") window.history.back();
          else if (action.kind === "home") live.current.router.replace(landingHome());
          else void App.minimizeApp();
        }),
      ),
    );
  }, []);

  // Account links finished in the system browser (routes/link-handoff.ts).
  useEffect(() => {
    const scheme = NATIVE_OAUTH_SCHEME;
    if (!scheme) return;
    return track(
      import("@capacitor/app").then(({ App }) =>
        App.addListener("appUrlOpen", (event) => {
          const handle = parseLinkComplete(event.url, scheme);
          if (!handle) return;
          void import("@capacitor/browser")
            .then(({ Browser }) => Browser.close())
            .catch(() => {
              // Already closed (or the user closed it) — nothing to do.
            });
          // The page redeems a parked handle with this app's own session.
          storePendingHandle(browserSessionStorage(), handle, Date.now());
          live.current.router.push("/link/complete");
        }),
      ),
    );
  }, []);

  return null;
}
