import { expect, type Page, test } from "@playwright/test";

/**
 * Calendar times follow the device zone when the account has no saved choice
 * (timezoneMode AUTO), even if the stored zone is UTC — the bug was a
 * 09:00 KST event rendering as 01:00/00:00. A pinned (MANUAL) zone still wins.
 *
 * The API is mocked; nothing else needs to be up:
 *   pnpm exec playwright test e2e/calendar-timezone.spec.ts
 */

test.use({ timezoneId: "Asia/Seoul", locale: "en-US" });

const TITLE = "TZ probe";

/** Tomorrow 09:00 in Asia/Seoul (UTC+9, no DST) as an ISO instant. */
function tomorrowNineSeoul(): { start: string; end: string } {
  const seoulNow = new Date(Date.now() + 9 * 3_600_000);
  const day = Date.UTC(
    seoulNow.getUTCFullYear(),
    seoulNow.getUTCMonth(),
    seoulNow.getUTCDate() + 1,
    0, // 09:00 KST = 00:00 UTC
  );
  return { start: new Date(day).toISOString(), end: new Date(day + 3_600_000).toISOString() };
}

async function mockApi(page: Page, user: Record<string, unknown>, patches: string[]) {
  const { start, end } = tomorrowNineSeoul();
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
          ...user,
        },
      },
    }),
  );
  await page.route("**/api/calendar?**", (route) =>
    route.fulfill({
      json: {
        events: [
          {
            id: "e1",
            title: TITLE,
            description: null,
            startTime: start,
            endTime: end,
            location: null,
            meetingLink: null,
            allDay: false,
          },
        ],
      },
    }),
  );
  await page.route("**/api/automations", (route) => {
    if (route.request().method() === "PATCH") patches.push(route.request().postData() ?? "");
    return route.fulfill({ json: {} });
  });
}

test("no saved zone: a 09:00 Seoul event renders 09:00 in a Seoul browser, and the zone is synced", async ({
  page,
}) => {
  const patches: string[] = [];
  await mockApi(page, { timezone: "UTC", timezoneMode: "AUTO" }, patches);
  await page.goto("/calendar");
  // The month grid's event chip: link named "HH:MM TZ probe".
  const next = page.getByRole("link", { name: new RegExp(TITLE) }).first();
  await expect(next).toContainText("09:00");
  await expect(next).not.toContainText("00:00");
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(JSON.parse(patches[0])).toEqual({ timezone: "Asia/Seoul", timezoneMode: "AUTO" });
});

test("a pinned zone wins over the device zone", async ({ page }) => {
  const patches: string[] = [];
  await mockApi(page, { timezone: "UTC", timezoneMode: "MANUAL" }, patches);
  await page.goto("/calendar");
  // The month grid's event chip: link named "HH:MM TZ probe".
  const next = page.getByRole("link", { name: new RegExp(TITLE) }).first();
  await expect(next).toContainText("00:00");
  expect(patches).toEqual([]);
});

test("Settings: Automatic is the default, the list is searchable, a pick saves as MANUAL", async ({
  page,
}) => {
  const patches: string[] = [];
  await mockApi(page, { timezone: "Asia/Seoul", timezoneMode: "AUTO" }, patches);
  await page.route("**/api/automations", (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postData() ?? "");
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: { timezone: "Asia/Seoul", timezoneMode: "AUTO" } });
  });
  await page.goto("/settings/appearance");
  const select = page.locator("#profile-tz");
  await expect(select).toHaveValue("auto");
  await expect(select.locator("option").first()).toContainText("Asia / Seoul");
  await expect(select.locator("option").first()).toContainText("UTC+9");
  await page.locator("#profile-tz-search").fill("denver");
  await expect(select.locator("option", { hasText: "Mountain Time — Denver" })).toHaveCount(1);
  await select.selectOption("America/Denver");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(JSON.parse(patches.at(-1) ?? "{}")).toEqual({
    timezone: "America/Denver",
    timezoneMode: "MANUAL",
  });
});
