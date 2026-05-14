import { expect, test } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 375, height: 812 };

test.describe("Mobile responsive — no horizontal overflow", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  const publicPages = ["/", "/login"];

  for (const path of publicPages) {
    test(`${path} fits within mobile viewport`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      // Allow up to 2px tolerance for scrollbar/subpixel rounding
      expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 2);
    });
  }

  test("landing hero heading is readable on mobile", async ({ page }) => {
    await page.goto("/");
    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible();
    const box = await h1.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // Hero fits within viewport
      expect(box.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    }
  });

  test("login form is not cut off on mobile", async ({ page }) => {
    await page.goto("/login");
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();
    const box = await emailInput.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // Input should be within viewport width
      expect(box.x + box.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
      // And within sensible vertical range (not scrolled off screen)
      expect(box.y).toBeGreaterThanOrEqual(0);
    }
  });

  test("CTA buttons are tappable size on mobile (>= 44px tall)", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: "Request early access from hero" });
    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("Tablet viewport smoke tests", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("landing page renders on tablet", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1").first()).toBeVisible();
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(770);
  });
});
