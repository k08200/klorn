import { expect, type Page, test } from "@playwright/test";

/**
 * Touch / narrow month view (founder decision, option A): on a coarse pointer
 * or a calendar narrower than 600px, the month grid becomes 44px day buttons
 * with event dots, and the selected day's events list below as ≥52px rows.
 * A fine pointer on a wide screen keeps the original grid with event chips.
 *
 * The API is mocked and the clock pinned; nothing else needs to be up:
 *   E2E_BASE_URL=http://localhost:8139 pnpm exec playwright test e2e/calendar-touch-month.spec.ts
 */

test.use({ timezoneId: "Asia/Seoul", locale: "en-US" });

// 2026-07-15 12:00 KST — a Wednesday in mid-July.
const NOW = new Date("2026-07-15T03:00:00Z");

/** An event at HH:MM Seoul time on a July 2026 day, `minutes` long. */
function ev(id: string, title: string, day: number, hhmm: string, minutes: number) {
  const [h, m] = hhmm.split(":").map(Number);
  const start = Date.UTC(2026, 6, day, h - 9, m);
  return {
    id,
    title,
    description: null,
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + minutes * 60_000).toISOString(),
    location: null,
    meetingLink: null,
    allDay: false,
  };
}

const EVENTS = [
  ev("e1", "Standup", 15, "09:00", 60),
  ev("e2", "Design review", 15, "14:00", 90),
  ev("e3", "Offsite A", 24, "10:00", 30),
  ev("e4", "Offsite B", 24, "11:00", 30),
  ev("e5", "Offsite C", 24, "12:00", 30),
  ev("e6", "Dentist", 3, "16:00", 45),
];

async function mockApi(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => localStorage.setItem("klorn-token", "e2e-test-token"));
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "u1",
          email: "operator@example.com",
          name: "Operator",
          plan: "PRO",
          role: "USER",
          googleConnected: true,
          googleNeedsReconnect: false,
          hasAnyMailSource: true,
          timezone: "Asia/Seoul",
          timezoneMode: "MANUAL",
        },
      },
    }),
  );
  await page.route("**/api/calendar?**", (route) => route.fulfill({ json: { events: EVENTS } }));
  await page.route("**/api/automations", (route) => route.fulfill({ json: {} }));
}

const dayButton = (page: Page, label: RegExp) =>
  page.getByRole("grid").getByRole("button", { name: label });

test.describe("touch phone (390×844, coarse pointer)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("day buttons are ≥44px, carry counts in their names, and hold no event links", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/calendar");
    const grid = page.getByRole("grid");
    await expect(grid).toBeVisible();
    await expect(grid.getByRole("link")).toHaveCount(0);

    await expect(dayButton(page, /July 15, 2 events/)).toBeVisible();
    await expect(dayButton(page, /July 24, 3 events/)).toBeVisible();
    await expect(dayButton(page, /July 2, no events/)).toBeVisible();
    await expect(dayButton(page, /July 3, 1 event$/)).toBeVisible();

    const box = await dayButton(page, /July 24,/).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });

  test("today is selected by default and its events list below as ≥52px rows", async ({ page }) => {
    await mockApi(page);
    await page.goto("/calendar");
    await expect(page.getByRole("gridcell", { selected: true })).toHaveCount(1);
    await expect(
      page.getByRole("gridcell", { selected: true }).getByRole("button"),
    ).toHaveAccessibleName(/July 15, 2 events/);

    const agenda = page.getByRole("region", { name: /July 15/ });
    const rows = agenda.getByRole("link");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Standup");
    await expect(rows.nth(0)).toContainText("09:00");
    await expect(rows.nth(0)).toContainText("10:00");
    await expect(rows.nth(1)).toContainText("Design review");
    await expect(rows.nth(0)).toHaveAttribute("href", "/calendar/e1");
    const box = await rows.nth(0).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(52);
  });

  test("tapping a day selects it and swaps the agenda; an empty day says so", async ({ page }) => {
    await mockApi(page);
    await page.goto("/calendar");

    await dayButton(page, /July 24,/).tap();
    await expect(
      page.getByRole("gridcell", { selected: true }).getByRole("button"),
    ).toHaveAccessibleName(/July 24, 3 events/);
    const agenda = page.getByRole("region", { name: /July 24/ });
    await expect(agenda.getByRole("link")).toHaveCount(3);
    await expect(agenda).not.toContainText("Standup");

    await dayButton(page, /July 2,/).tap();
    const empty = page.getByRole("region", { name: /July 2\b/ });
    await expect(empty.getByRole("link")).toHaveCount(0);
    await expect(empty).toContainText("Nothing on this day.");
  });

  test("another month defaults to its 1st", async ({ page }) => {
    await mockApi(page);
    await page.goto("/calendar");
    await page.getByRole("button", { name: "Next month" }).tap();
    await expect(
      page.getByRole("gridcell", { selected: true }).getByRole("button"),
    ).toHaveAccessibleName(/August 1,/);
  });
});

test.describe("keyboard on the compact grid", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("arrows move focus between days with one tab stop; Enter selects", async ({ page }) => {
    await mockApi(page);
    await page.goto("/calendar");
    const grid = page.getByRole("grid");
    await expect(grid).toBeVisible();
    // Roving tabindex: exactly one day is in the tab order.
    await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);

    await dayButton(page, /July 15,/).focus();
    await page.keyboard.press("ArrowRight");
    await expect(dayButton(page, /July 16,/)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(dayButton(page, /July 23,/)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(dayButton(page, /July 22,/)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(dayButton(page, /July 15,/)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(dayButton(page, /July 29,/)).toBeFocused();
    // Selection only moves on Enter / Space.
    await expect(
      page.getByRole("gridcell", { selected: true }).getByRole("button"),
    ).toHaveAccessibleName(/July 15,/);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("gridcell", { selected: true }).getByRole("button"),
    ).toHaveAccessibleName(/July 29,/);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("gridcell", { selected: true }).getByRole("button"),
    ).toHaveAccessibleName(/July 30,/);
    await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
  });
});

test.describe("touch tablet (1024×768, coarse pointer)", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test("a wide touch screen also gets the compact grid", async ({ page }) => {
    await mockApi(page);
    await page.goto("/calendar");
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByRole("link", { name: /Offsite A/ })).toHaveCount(0);
  });
});

test.describe("desktop (1280×800, fine pointer)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the original month grid with event chips", async ({ page }) => {
    await mockApi(page);
    await page.goto("/calendar");
    await expect(page.getByRole("link", { name: /09:00\s*Standup/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Offsite C/ })).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    // The date-number day trigger is still there with its original name.
    await expect(page.getByRole("button", { name: /July 24 — 3 events/ })).toBeVisible();
  });
});
