import { expect, test } from "@playwright/test";

const PROTECTED_ROUTES = ["/chat", "/calendar", "/email", "/settings", "/billing"];

const LEGACY_PROTECTED_ROUTES = [
  ["/dashboard", "/inbox"],
  ["/tasks", "/inbox"],
  ["/notes", "/files"],
  ["/contacts", "/email/candidates"],
  ["/reminders", "/inbox"],
  ["/skills", "/settings/memory"],
  ["/notifications", "/briefing"],
  ["/workspace", "/files"],
] as const;

test.describe("Protected routes", () => {
  for (const route of PROTECTED_ROUTES) {
    test(`${route} is protected from unauthenticated access`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(route)}`));
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.getByText("No decision threads yet.")).toHaveCount(0);
    });
  }

  for (const [route, destination] of LEGACY_PROTECTED_ROUTES) {
    test(`${route} redirects to ${destination} before sign in`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(destination)}`));
      await expect(page.locator('input[type="email"]')).toBeVisible();
    });
  }

  test("admin route is gated even more strictly", async ({ page }) => {
    await page.goto("/admin");
    await page.waitForTimeout(1500);
    const body = await page.locator("body").textContent();
    // Should show either login or "Admin access required" message
    const gated =
      body?.includes("Admin access required") ||
      body?.includes("Sign in") ||
      (await page
        .locator('input[type="email"]')
        .isVisible()
        .catch(() => false));
    expect(gated).toBeTruthy();
  });
});
