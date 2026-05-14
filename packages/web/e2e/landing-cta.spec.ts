import { expect, test } from "@playwright/test";

test.describe("Landing page CTAs and conversion paths", () => {
  test("CTA buttons are reachable without JavaScript errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(errors).toHaveLength(0);
  });

  test("early access CTA leads to the application form", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: "Request early access from hero" });
    await cta.click();
    await expect(page).toHaveURL(/\/early-access/);
  });

  test("log in link in nav leads to login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("landing page has no broken image placeholders", async ({ page }) => {
    await page.goto("/");
    const images = await page.locator("img").all();
    for (const img of images) {
      const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
      // 0 width means image failed to load
      if (naturalWidth === 0) {
        const src = await img.getAttribute("src");
        throw new Error(`Image failed to load: ${src}`);
      }
    }
  });

  test("landing page is responsive on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    // Hero heading should still be visible
    await expect(page.locator("h1").first()).toBeVisible();
    // No horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 2);
  });
});
