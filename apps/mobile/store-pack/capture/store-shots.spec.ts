/**
 * Store screenshot set — see playwright.store.config.ts and
 * ../screenshots-plan.md. Each target renders at a pixel size the store
 * accepts (viewport × device scale), light theme, Korean and English chrome.
 * The fixture mail itself is Korean in both locales.
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp, settle } from "../../e2e/helpers";
import { holdSwipe } from "../../e2e/mail-helpers";

const OUT = process.env.KLORN_STORE_SHOTS_DIR ?? `${process.cwd()}/test-results/store-shots`;

/** viewport (CSS px) × dpr = the uploaded pixel size. */
const TARGETS = [
  // App Store iPhone 6.9" — 1320 × 2868
  { name: "ios-6.9", width: 440, height: 956, dpr: 3, insets: "62,0,34,0" },
  // App Store iPad 13" — 2064 × 2752
  { name: "ipad-13", width: 1032, height: 1376, dpr: 2, insets: "24,0,20,0" },
  // Play phone — 1080 × 1920 (9:16)
  { name: "play-phone", width: 360, height: 640, dpr: 3, insets: "24,0,16,0" },
  // Play 7" tablet — 1920 × 1080 (16:9, rail layout)
  { name: "play-tablet-7", width: 960, height: 540, dpr: 2, insets: "24,0,16,0" },
  // Play 10" tablet — 2560 × 1440 (16:9, sidebar layout)
  { name: "play-tablet-10", width: 1280, height: 720, dpr: 2, insets: "24,0,16,0" },
] as const;

const LOCALES = [
  {
    tag: "ko-KR",
    short: "ko",
    edit: "고쳐 쓰기",
    review: "보내기 검토",
    confirm: "보내기 전에 확인",
  },
  {
    tag: "en-US",
    short: "en",
    edit: "Edit",
    review: "Review & send",
    confirm: "Review before sending",
  },
] as const;

type Locale = (typeof LOCALES)[number];

const SCREENS: {
  name: string;
  path: string;
  act?: (page: Page, l: Locale) => Promise<void>;
  /** Screenshot while this is still running (a held swipe), then release. */
  hold?: (page: Page) => Promise<() => Promise<void>>;
}[] = [
  { name: "01-today", path: "/today" },
  { name: "02-mail", path: "/mail" },
  { name: "03-reader", path: "/mail/email-att-push-1" },
  {
    name: "04-confirm-send",
    path: "/mail/email-att-push-1",
    act: async (page, l) => {
      await page.getByRole("button", { name: l.edit }).click();
      await page.getByRole("button", { name: l.review }).click();
      await expect(page.getByRole("dialog", { name: l.confirm })).toBeVisible();
    },
  },
  { name: "05-calendar", path: "/calendar" },
  { name: "06-approvals", path: "/assistant/approvals" },
  { name: "07-push-priming", path: "/today?priming=1" },
  {
    name: "08-swipe-done",
    path: "/mail",
    hold: (page) => holdSwipe(page, page.getByRole("link", { name: /김도윤/ }).first(), 96),
  },
];

for (const target of TARGETS) {
  for (const locale of LOCALES) {
    test.describe(`${target.name} · ${locale.short}`, () => {
      test.use({
        viewport: { width: target.width, height: target.height },
        deviceScaleFactor: target.dpr,
        locale: locale.tag,
      });
      for (const screen of SCREENS) {
        test(screen.name, async ({ page }) => {
          await openApp(page, screen.path, { theme: "light", insets: target.insets });
          await settle(page);
          if (screen.act) {
            await screen.act(page, locale);
            await settle(page);
          }
          const release = screen.hold ? await screen.hold(page) : null;
          await page.waitForTimeout(250);
          await page.screenshot({
            path: `${OUT}/${target.name}/${locale.short}/${screen.name}.png`,
          });
          await release?.();
        });
      }
    });
  }
}
