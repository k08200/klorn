/**
 * Visual specs for Calendar, Assistant, Files, Accounts, Settings, Plans,
 * push priming and the expanded layout's assistant side sheet — every screen
 * at every form factor in light and dark, plus their loading / empty / error /
 * offline / features-off states. Screenshots go to $KLORN_SHOTS_DIR.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  emulateHinge,
  type Hinge,
  openApp,
  SHOTS_DIR,
  segmentCount,
  settle,
  snap,
} from "./helpers";

interface Device {
  name: string;
  width: number;
  height: number;
  hinge?: Hinge;
  insets?: string;
}

const DEVICES: Device[] = [
  { name: "iphone-390x844", width: 390, height: 844, insets: "47,0,34,0" },
  { name: "android-412x915", width: 412, height: 915, insets: "24,0,16,0" },
  { name: "fold-open-884x1104", width: 884, height: 1104 },
  {
    name: "fold-hinge-884x1104",
    width: 884,
    height: 1104,
    hinge: { orientation: "vertical", offset: 442, maskLength: 0 },
  },
  {
    name: "fold-tabletop-884x1104",
    width: 884,
    height: 1104,
    hinge: { orientation: "horizontal", offset: 540, maskLength: 24 },
  },
  { name: "ipad-mini-744x1133", width: 744, height: 1133 },
  { name: "ipad-landscape-1366x1024", width: 1366, height: 1024, insets: "24,0,20,0" },
];

interface Screen {
  name: string;
  path: string;
  /** What must be on screen before the shot. */
  ready: (page: Page) => Promise<void>;
  /** Open a sheet or similar before the shot. */
  open?: (page: Page) => Promise<void>;
}

const heading = (page: Page, name: string) =>
  expect(page.getByRole("heading", { name, level: 1 }).first()).toBeVisible();

const SCREENS: Screen[] = [
  { name: "calendar", path: "/calendar", ready: (p) => heading(p, "10월") },
  {
    name: "calendar-event",
    path: "/calendar/evt-investor",
    ready: (p) => heading(p, "투자사 미팅 · Mark Chen"),
  },
  {
    name: "calendar-new",
    path: "/calendar",
    ready: (p) => heading(p, "10월"),
    open: async (p) => {
      await p.getByRole("button", { name: "새 일정" }).click();
      await expect(p.getByRole("dialog", { name: "새 일정" })).toBeVisible();
    },
  },
  {
    name: "calendar-team",
    path: "/calendar",
    ready: (p) => heading(p, "10월"),
    open: async (p) => {
      await p.getByRole("button", { name: "팀 빈 시간" }).click();
      await expect(p.getByRole("radio", { name: /10월 21일/ })).toBeVisible();
    },
  },
  { name: "assistant-chat", path: "/assistant/chat", ready: (p) => heading(p, "도우미") },
  {
    name: "assistant-approvals",
    path: "/assistant/approvals",
    ready: (p) =>
      expect(p.getByText("Re: 계약서 수정본 — 오늘 서명 가능할까요?").first()).toBeVisible(),
  },
  {
    name: "assistant-approval-detail",
    path: "/assistant/approvals/pa-reply",
    ready: (p) => expect(p.getByText("seoyeon@hanbitpartners.example").first()).toBeVisible(),
  },
  {
    name: "assistant-activity",
    path: "/assistant/activity",
    ready: (p) => expect(p.getByText("오늘 메일 48통 중 2통만")).toBeVisible(),
  },
  { name: "files", path: "/files", ready: (p) => heading(p, "파일") },
  {
    name: "files-detail",
    path: "/files/drv-budget",
    ready: (p) => heading(p, "2026 Q4 예산.xlsx"),
  },
  { name: "accounts", path: "/accounts", ready: (p) => heading(p, "계정과 소스") },
  {
    name: "accounts-add",
    path: "/accounts",
    ready: (p) => heading(p, "계정과 소스"),
    open: async (p) => {
      await p.getByRole("button", { name: /계정 추가/ }).click();
      await expect(p.getByRole("dialog", { name: "계정 추가" })).toBeVisible();
    },
  },
  { name: "settings", path: "/settings", ready: (p) => heading(p, "설정") },
  {
    name: "settings-notifications",
    path: "/settings/notifications",
    ready: (p) => heading(p, "알림"),
  },
  { name: "settings-plans", path: "/settings/plans", ready: (p) => heading(p, "요금제") },
  {
    // A faked App Store offer (mock builds only): the 3.1.2 disclosures.
    name: "settings-plans-store",
    path: "/settings/plans?iap=ios",
    ready: (p) => expect(p.getByRole("heading", { name: "Klorn Pro", level: 2 })).toBeVisible(),
  },
  {
    name: "settings-delete",
    path: "/settings/delete-account",
    ready: (p) => heading(p, "계정 삭제"),
  },
  {
    name: "push-priming",
    path: "/today?priming=1",
    ready: (p) => heading(p, "꼭 필요할 때만 울려요"),
  },
];

async function open(page: Page, device: Device, path: string, theme: "light" | "dark") {
  await page.setViewportSize({ width: device.width, height: device.height });
  await openApp(page, path, { theme, insets: device.insets });
  if (device.hinge) {
    expect(await emulateHinge(page, device.hinge), "CDP display-feature emulation").toBe(true);
    await expect.poll(() => segmentCount(page)).toBe(2);
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const screen of SCREENS) {
    for (const device of DEVICES) {
      test(`${screen.name} · ${device.name} · ${theme}`, async ({ page }) => {
        await open(page, device, screen.path, theme);
        await settle(page);
        await screen.ready(page);
        if (screen.open) {
          await screen.open(page);
          await settle(page);
        }
        await snap(page, `${SHOTS_DIR}/${screen.name}-${device.name}-${theme}.png`);
      });
    }
  }

  test(`assistant side sheet · ipad-landscape-1366x1024 · ${theme}`, async ({ page }) => {
    const device = DEVICES[DEVICES.length - 1] as Device;
    await open(page, device, "/today", theme);
    await settle(page);
    await page.getByRole("button", { name: "도우미에게 묻기" }).click();
    const sheet = page.getByRole("dialog", { name: "도우미" });
    await expect(sheet.getByText("디자인팀 회의")).toBeVisible();
    await snap(page, `${SHOTS_DIR}/assistant-sheet-${device.name}-${theme}.png`);
  });

  test(`flip cover · 360x400 · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 400 });
    await openApp(page, "/calendar", { theme });
    await settle(page);
    await expect(page.getByText("박서연 · 회사")).toBeVisible();
    await snap(page, `${SHOTS_DIR}/cover-360x400-${theme}.png`);
  });
}

const STATE_PATHS = [
  { name: "calendar", path: "/calendar" },
  { name: "assistant-chat", path: "/assistant/chat" },
  { name: "assistant-approvals", path: "/assistant/approvals" },
  { name: "assistant-activity", path: "/assistant/activity" },
  { name: "files", path: "/files" },
  { name: "accounts", path: "/accounts" },
  { name: "settings-notifications", path: "/settings/notifications" },
];

for (const scenario of ["loading", "empty", "error", "featuresOff"] as const) {
  for (const s of STATE_PATHS) {
    test(`state · ${scenario} · ${s.name} · 390x844`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openApp(page, s.path, { scenario, insets: "47,0,34,0" });
      await snap(page, `${SHOTS_DIR}/state-${scenario}-${s.name}-390x844.png`, {
        loading: scenario === "loading",
      });
    });
  }
}

test("state · offline without cache · calendar + files · 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const s of [
    { name: "calendar", path: "/calendar" },
    { name: "files", path: "/files" },
  ]) {
    await openApp(page, s.path, { scenario: "offline", insets: "47,0,34,0" });
    await expect(
      page.getByRole("alert").filter({ hasText: "오프라인이에요" }).first(),
    ).toBeVisible();
    await snap(page, `${SHOTS_DIR}/state-offline-${s.name}-390x844.png`);
  }
});
