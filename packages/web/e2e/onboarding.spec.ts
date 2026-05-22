import { expect, test } from "@playwright/test";

test.describe("Onboarding wizard", () => {
  test("unauthenticated user is redirected to login", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/login/);
  });

  test("step 1 shows Connect Gmail button and Skip option", async ({ page }) => {
    // Land on login and switch to register mode
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();

    await page.locator('input[type="email"]').fill(`onboard-test-${Date.now()}@example.com`);
    await page.locator('input[type="password"]').fill("password123!");
    await page.getByRole("button", { name: /create account/i }).click();

    // Register redirects to /onboarding
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 10_000 });

    // Step 1 content
    await expect(page.getByText("Your AI Chief of Staff")).toBeVisible();
    await expect(page.getByRole("link", { name: /connect gmail/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /skip for now/i })).toBeVisible();
  });

  test("skip button navigates to inbox", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();

    await page.locator('input[type="email"]').fill(`skip-test-${Date.now()}@example.com`);
    await page.locator('input[type="password"]').fill("password123!");
    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/onboarding/, { timeout: 10_000 });
    await page.getByRole("button", { name: /skip for now/i }).click();
    await expect(page).toHaveURL(/\/inbox/, { timeout: 10_000 });
  });

  test("progress dots show 3 steps with first active", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();

    await page.locator('input[type="email"]').fill(`dots-test-${Date.now()}@example.com`);
    await page.locator('input[type="password"]').fill("password123!");
    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/onboarding/, { timeout: 10_000 });

    // 3 progress dots rendered
    const dots = page.locator(".mt-12 > div > div");
    await expect(dots).toHaveCount(3);
    // First dot is wider (active = w-6)
    const firstDotClass = await dots.nth(0).getAttribute("class");
    expect(firstDotClass).toContain("w-6");
  });

  test("feature icons are visible on step 1", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();

    await page.locator('input[type="email"]').fill(`icons-test-${Date.now()}@example.com`);
    await page.locator('input[type="password"]').fill("password123!");
    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/onboarding/, { timeout: 10_000 });

    await expect(page.getByText("Reads your inbox")).toBeVisible();
    await expect(page.getByText("Tracks commitments")).toBeVisible();
    await expect(page.getByText("Surfaces decisions")).toBeVisible();
  });

  test("connect button sets onboarding localStorage flag", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();

    await page.locator('input[type="email"]').fill(`flag-test-${Date.now()}@example.com`);
    await page.locator('input[type="password"]').fill("password123!");
    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/onboarding/, { timeout: 10_000 });

    // Intercept navigation so we stay on page to check localStorage
    await page.route("**/api/auth/google*", (route) => route.abort());

    const connectLink = page.getByRole("link", { name: /connect gmail/i });
    // Click and immediately check localStorage (navigation will be aborted)
    await connectLink.click().catch(() => {});

    const flag = await page.evaluate(() => localStorage.getItem("klorn_onboarding_active"));
    expect(flag).toBe("true");
  });
});
