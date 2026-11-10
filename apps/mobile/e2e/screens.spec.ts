/**
 * Visual specs: Today + shell at every form factor in light and dark, the
 * Flip cover screen, Welcome, and the loading / empty / error / offline
 * states. Screenshots go to $KLORN_SHOTS_DIR (default test-results/shots).
 */
import { expect, test } from "@playwright/test";
import {
  emulateHinge,
  type Hinge,
  openApp,
  SHOTS_DIR,
  segmentCount,
  settle,
  snap,
  untilPersisted,
} from "./helpers";

interface Device {
  name: string;
  width: number;
  height: number;
  hinge?: Hinge;
  /** Simulated safe-area insets "top,right,bottom,left" (status bar, home indicator). */
  insets?: string;
  /** What the shell must render at this size. */
  nav: "tabs" | "rail" | "sidebar" | "none";
}

const DEVICES: Device[] = [
  { name: "iphone-390x844", width: 390, height: 844, insets: "47,0,34,0", nav: "tabs" },
  { name: "android-412x915", width: 412, height: 915, insets: "24,0,16,0", nav: "tabs" },
  { name: "fold-open-884x1104", width: 884, height: 1104, nav: "rail" },
  {
    name: "fold-hinge-884x1104",
    width: 884,
    height: 1104,
    nav: "rail",
    hinge: { orientation: "vertical", offset: 442, maskLength: 0 },
  },
  {
    name: "fold-tabletop-884x1104",
    width: 884,
    height: 1104,
    nav: "tabs",
    hinge: { orientation: "horizontal", offset: 540, maskLength: 24 },
  },
  {
    name: "ipad-portrait-1024x1366",
    width: 1024,
    height: 1366,
    insets: "24,0,20,0",
    nav: "sidebar",
  },
  {
    name: "ipad-landscape-1366x1024",
    width: 1366,
    height: 1024,
    insets: "24,0,20,0",
    nav: "sidebar",
  },
  { name: "ipad-mini-portrait-744x1133", width: 744, height: 1133, nav: "rail" },
];

for (const theme of ["light", "dark"] as const) {
  for (const device of DEVICES) {
    test(`today · ${device.name} · ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height });
      if (device.hinge) {
        await openApp(page, "/today", { theme, insets: device.insets });
        const ok = await emulateHinge(page, device.hinge);
        expect(ok, "CDP display-feature emulation available").toBe(true);
        await expect.poll(() => segmentCount(page)).toBe(2);
      } else {
        await openApp(page, "/today", { theme, insets: device.insets });
      }
      await settle(page);
      const shell = page.locator(".shell");
      await expect(shell).toHaveAttribute("data-nav", device.nav);
      if (device.hinge) {
        await expect(shell).toHaveAttribute(
          "data-posture",
          device.hinge.orientation === "vertical" ? "book" : "tabletop",
        );
      }
      await expect(page.getByRole("heading", { name: "오늘", level: 1 })).toBeVisible();
      await snap(page, `${SHOTS_DIR}/today-${device.name}-${theme}.png`);
    });
  }

  test(`flip cover · 360x400 · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 400 });
    await openApp(page, "/today", { theme });
    await settle(page);
    await expect(page.locator(".cover")).toBeVisible();
    await expect(page.getByText("박서연 님이 계약서 회신을 기다려요")).toBeVisible();
    await snap(page, `${SHOTS_DIR}/cover-flip-360x400-${theme}.png`);
  });

  test(`welcome · 390x844 · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/today", { scenario: "signedOut", theme, insets: "47,0,34,0" });
    await expect(page.getByRole("button", { name: "Google로 계속하기" })).toBeVisible();
    await snap(page, `${SHOTS_DIR}/welcome-390x844-${theme}.png`);
  });

  test(`welcome sign-up · invite-only · 390x844 · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/today?signup=closed", {
      scenario: "signedOut",
      theme,
      insets: "47,0,34,0",
    });
    await page.getByRole("button", { name: "이메일로 계속하기" }).click();
    await page.getByRole("button", { name: "계정이 없나요? 이메일로 가입하기" }).click();
    await expect(page.getByRole("status").filter({ hasText: "초대받은 분만" })).toBeVisible();
    await snap(page, `${SHOTS_DIR}/welcome-signup-390x844-${theme}.png`);
  });

  test(`mail split · fold hinge · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 884, height: 1104 });
    await openApp(page, "/mail/email-att-push-1", { theme });
    await emulateHinge(page, { orientation: "vertical", offset: 442, maskLength: 0 });
    await expect.poll(() => segmentCount(page)).toBe(2);
    await settle(page);
    await expect(
      page.getByRole("heading", { name: "계약서 수정본 — 오늘 서명 가능할까요?" }),
    ).toBeVisible();
    await snap(page, `${SHOTS_DIR}/mail-fold-hinge-884x1104-${theme}.png`);
  });
}

for (const scenario of ["loading", "empty", "error", "noAccounts"] as const) {
  test(`state · ${scenario} · 390x844`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/today", { scenario, insets: "47,0,34,0" });
    await snap(page, `${SHOTS_DIR}/state-${scenario}-390x844.png`, {
      loading: scenario === "loading",
    });
  });
}

test("state · offline with cached data · 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/today");
  await settle(page);
  // Let the persister flush the cache (throttled 1 s), then lose the network.
  await untilPersisted(page, '"mail","firewall"');
  // Cold start with no network: the bundle is local (here: served before the
  // cut), the API is unreachable, and the OS reports offline.
  await page.goto("/today?scenario=offline");
  await page.context().setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "오프라인이에요" })).toBeVisible();
  await expect(page.getByText("박서연 님이 계약서 회신을 기다려요")).toBeVisible();
  await snap(page, `${SHOTS_DIR}/state-offline-cached-390x844.png`);
});

test("state · offline without cache · 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/today", { scenario: "offline" });
  await expect(page.getByRole("alert").filter({ hasText: "오프라인이에요" })).toBeVisible();
  await snap(page, `${SHOTS_DIR}/state-offline-empty-390x844.png`);
});
