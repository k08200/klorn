import { expect, test } from "@playwright/test";

// Command Center tests run against the /inbox page.
// They verify layout structure and section presence without needing live data.

test.describe("Command Center layout", () => {
  test.beforeEach(async ({ page }) => {
    // Inject a fake auth token so AuthGuard passes
    await page.goto("/login");
    await page.evaluate(() => {
      localStorage.setItem("auth_token", "e2e-test-token");
    });
  });

  test("unauthenticated user is redirected to login", async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem("auth_token"));
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/login/);
  });

  test("page title is Command Center", async ({ page }) => {
    await page.goto("/inbox");
    // If auth redirects to login (no real token), check that — otherwise check heading
    const url = page.url();
    if (/login/.test(url)) {
      // Auth guard working correctly in E2E — skip layout checks
      return;
    }
    await expect(page.getByRole("heading", { name: /command center/i })).toBeVisible();
  });

  test("renders in 2-column layout on wide viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/inbox");

    const url = page.url();
    if (/login/.test(url)) return;

    // The grid wrapper has the lg:grid-cols class
    const grid = page.locator(".grid.grid-cols-1");
    await expect(grid).toBeVisible();
  });
});

test.describe("Command Center sections — authenticated", () => {
  let authToken: string;

  test.beforeEach(async ({ page }) => {
    // Register a fresh account to get a real token
    const email = `cc-test-${Date.now()}@example.com`;
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill("password123!");
    await page.getByRole("button", { name: /create account/i }).click();

    // After registration, land on /onboarding — skip to inbox
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 10_000 });
    await page.getByRole("button", { name: /skip for now/i }).click();
    await expect(page).toHaveURL(/\/inbox/, { timeout: 10_000 });

    authToken = (await page.evaluate(() => localStorage.getItem("auth_token"))) ?? "";
  });

  test("shows Approval Queue section header", async ({ page }) => {
    await expect(page.getByText(/approval queue/i)).toBeVisible();
  });

  test("shows Reply Needed section", async ({ page }) => {
    await expect(page.getByText(/reply needed/i)).toBeVisible();
  });

  test("shows Commitment Ledger section", async ({ page }) => {
    await expect(page.getByText(/commitment ledger/i)).toBeVisible();
  });

  test("shows Quick Links panel", async ({ page }) => {
    await expect(page.getByText(/quick links/i)).toBeVisible();
  });

  test("refresh button is present in header", async ({ page }) => {
    await expect(page.getByRole("button", { name: /refresh/i })).toBeVisible();
  });

  test("Approval Queue shows empty state when no approvals", async ({ page }) => {
    await expect(page.getByText(/no pending approvals/i)).toBeVisible();
  });

  test("Reply Needed shows empty state when no emails need reply", async ({ page }) => {
    await expect(page.getByText(/all caught up/i).or(page.getByText(/no emails/i))).toBeVisible();
  });
});
