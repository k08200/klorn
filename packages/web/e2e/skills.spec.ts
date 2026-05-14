import { expect, test } from "@playwright/test";

test.describe("Skills page", () => {
  test("skills route requires authentication", async ({ page }) => {
    await page.goto("/skills");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fmemory/);
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test("skills route keeps old links away from 404s", async ({ page }) => {
    await page.goto("/skills");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fmemory/);
    await expect(page.getByText("This workspace view is unavailable.")).toHaveCount(0);
  });
});
