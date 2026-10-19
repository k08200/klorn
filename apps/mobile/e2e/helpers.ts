import { expect, type Page } from "@playwright/test";

/** The fixture clock: Thursday 2026-10-16 10:28 KST (Main artboard: "11:00 · 32분 후"). */
export const FIXTURE_NOW = new Date("2026-10-16T10:28:00+09:00");

export const SHOTS_DIR = process.env.KLORN_SHOTS_DIR ?? `${process.cwd()}/test-results/shots`;

export interface Hinge {
  orientation: "vertical" | "horizontal";
  offset: number;
  maskLength: number;
}

/**
 * Emulate a fold through Chromium's device-metrics display feature (what
 * DevTools' foldable devices use). This drives the real Viewport Segments API,
 * env(viewport-segment-*) and the (horizontal|vertical)-viewport-segments
 * media queries — not an app-side simulation.
 */
export async function emulateHinge(page: Page, hinge: Hinge): Promise<boolean> {
  const size = page.viewportSize();
  if (!size) return false;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
      displayFeature: hinge,
    });
  } catch {
    return false;
  }
  return true;
}

export async function segmentCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { viewport?: { segments?: unknown[] | null } }).viewport?.segments
        ?.length ?? 0,
  );
}

export async function openApp(
  page: Page,
  path: string,
  options: { scenario?: string; theme?: "light" | "dark"; insets?: string } = {},
): Promise<void> {
  // install (not setFixedTime): time flows from the fixture instant, so
  // throttles and timers behave; a test lasts seconds, the copy is per minute.
  await page.clock.install({ time: FIXTURE_NOW });
  await page.emulateMedia({ colorScheme: options.theme ?? "light", reducedMotion: "reduce" });
  const sep = path.includes("?") ? "&" : "?";
  const insets = options.insets ? `&insets=${options.insets}` : "";
  await page.goto(`${path}${sep}scenario=${options.scenario ?? "default"}${insets}`);
}

/** In the page: the screen's data has settled (see `settle`). Self-contained — it is serialised. */
function settledProbe(): boolean {
  const moving = document
    .getAnimations()
    .some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
  return (
    document.documentElement.dataset.ready === "true" &&
    document.querySelector('[aria-busy="true"], .skeleton') === null &&
    !moving
  );
}

/** In the page: past boot and the screen chunk, showing its loading state (see `untilSkeleton`). */
function loadingProbe(): boolean {
  return (
    document.documentElement.dataset.ready === "false" &&
    document.querySelector(".boot") === null &&
    document.querySelector('[aria-busy="true"], .skeleton') !== null
  );
}

/**
 * Wait until `probe` holds, fonts are loaded, and it still holds two animation
 * frames later (so that DOM has been painted and nothing started loading in
 * between) — retrying until the deadline. waitForFunction's predicate stays
 * synchronous: it would take a returned Promise as "truthy" at once.
 */
async function until(page: Page, probe: () => boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.waitForFunction(probe, null, { timeout: Math.max(1, deadline - Date.now()) });
    const stable = await page.evaluate(
      `(async () => {
        await document.fonts.ready;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return (${probe.toString()})();
      })()`,
    );
    if (stable === true) return;
    if (Date.now() > deadline) throw new Error(`${probe.name} did not hold within ${timeout} ms`);
  }
}

/**
 * Wait until the screen's data has settled — never a fixed sleep:
 *   - `<html data-ready="true">` (src/ui/ReadySignal.tsx): past boot (session,
 *     language catalog, restored cache) and no query fetching;
 *   - no `[aria-busy=true]` and no `.skeleton` left in the DOM;
 *   - no finite CSS animation / transition still running (a sheet fading in);
 *   - web fonts loaded, and all of it still true two frames later.
 */
export async function settle(page: Page): Promise<void> {
  await until(page, settledProbe);
}

/**
 * The loading-state screenshots: wait until the app is past boot and its
 * screen chunk (no `.boot` placeholder left) and shows its loading state —
 * skeletons or an `aria-busy` region (the "loading" mock scenario never answers).
 */
export async function untilSkeleton(page: Page): Promise<void> {
  await until(page, loadingProbe);
}

/**
 * The offline-cache specs: wait until the persister has written the cache
 * (throttled 1 s) and it holds `needle` — a query key fragment such as
 * "firewall" — before the network goes away.
 */
export async function untilPersisted(page: Page, needle: string): Promise<void> {
  // The cache is sealed (platform/cache-crypto.ts): open it in the page with
  // the browser-mode key, exactly as the app does. The stored bytes themselves
  // must never contain the fragment in the clear. (Polled with evaluate, not
  // waitForFunction: an async predicate's Promise would count as truthy there.)
  const holds = () =>
    page.evaluate(async (fragment) => {
      const stored = localStorage.getItem("klorn-query-cache-v2");
      const rawKey = localStorage.getItem("klorn-cache-key");
      if (!stored || !rawKey) return "empty";
      if (stored.includes(fragment)) return "plaintext";
      const bytes = (b64: string) =>
        Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const [format, iv, body] = stored.split(".");
      if (format !== "kc1" || !iv || !body) return "format";
      try {
        const key = await crypto.subtle.importKey("raw", bytes(rawKey), "AES-GCM", false, [
          "decrypt",
        ]);
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes(iv) },
          key,
          bytes(body),
        );
        return new TextDecoder().decode(plain).includes(fragment) ? "ok" : "missing";
      } catch {
        return "unreadable";
      }
    }, needle);
  await expect.poll(holds, { timeout: 15_000, intervals: [100, 250, 500] }).toBe("ok");
}

/**
 * Every screenshot goes through here: wait for the settled screen (`settle`)
 * — or, for a loading-state picture, its skeleton (`untilSkeleton`) — then
 * capture. No fixed sleeps.
 */
export async function snap(
  page: Page,
  path: string,
  { loading = false }: { loading?: boolean } = {},
): Promise<void> {
  if (loading) await untilSkeleton(page);
  else await settle(page);
  await page.screenshot({ path });
}
