import { expect, test } from "@playwright/test";

test.describe("Authentication", () => {
  test("login page loads with email and password fields", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Open decision queue" })).toBeVisible();
  });

  test("shows register mode toggle", async ({ page }) => {
    await page.goto("/login");
    const toggle = page.getByRole("button", { name: "Switch to sign-up" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    await expect(page.locator('input[id="name"]')).toBeVisible();
  });

  test("shows Google login button with Beta badge", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: "Google sign-in coming soon Beta" }),
    ).toBeVisible();
  });

  test("explains private beta access", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Private beta access is email-based.")).toBeVisible();
  });

  test("shows reset password link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Reset password" })).toBeVisible();
  });

  test("password field requires minimum 8 characters for registration", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to sign-up" }).click();
    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toHaveAttribute("minLength", "8");
  });

  test("protected route redirects with a return destination", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    await expect(page.getByText("Sign in to continue to")).toBeVisible();
    await expect(page.getByText("/settings")).toBeVisible();
  });
});
