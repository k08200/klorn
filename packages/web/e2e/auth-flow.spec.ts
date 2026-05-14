import { expect, test } from "@playwright/test";

test.describe("Authentication flow — error states and validation", () => {
  test("invalid email format shows validation", async ({ page }) => {
    await page.goto("/login");
    const emailInput = page.locator('input[type="email"]');
    await emailInput.fill("not-an-email");
    // HTML5 validation should mark it invalid
    const isValid = await emailInput.evaluate((el: HTMLInputElement) => el.validity.valid);
    expect(isValid).toBe(false);
  });

  test("empty password keeps submit disabled", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("test@example.com");
    const submitBtn = page.getByRole("button", { name: "Open decision queue" });
    await expect(submitBtn).toBeDisabled();
    await expect(page).toHaveURL(/\/login/);
  });

  test("register mode shows optional name field", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();
    const nameInput = page.locator('input[id="name"]');
    await expect(nameInput).toBeVisible();
    const required = await nameInput.getAttribute("required");
    expect(required).toBeNull();
  });

  test("reset password link leads to reset flow", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Reset password" }).click();
    await expect(page).toHaveURL(/\/reset-password/);
  });

  test("toggle between sign in and sign up preserves layout", async ({ page }) => {
    await page.goto("/login");
    const loginBtn = page.getByRole("button", { name: "Open decision queue" });
    await expect(loginBtn).toBeVisible();

    await page.getByRole("button", { name: "Switch to sign-up" }).click();
    const createBtn = page.locator('button:has-text("Create account")');
    await expect(createBtn).toBeVisible();

    // Toggle back
    await page.getByRole("button", { name: "Switch to log-in" }).click();
    await expect(loginBtn).toBeVisible();
  });
});
