import { expect, test } from "@playwright/test";

test.describe("Authentication", () => {
  test("login page loads with email and password fields", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("shows register mode toggle", async ({ page }) => {
    await page.goto("/login");
    const toggle = page.getByRole("button", { name: "Create an account" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    await expect(page.locator('input[id="name"]')).toBeVisible();
  });

  test("shows the Google sign-in row", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  });

  test("links the published security facts under the form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: /CASA Tier 2/ })).toHaveAttribute(
      "href",
      "https://klorn.ai/security/",
    );
  });

  test("shows reset password link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Reset password" })).toBeVisible();
  });

  test("password field requires minimum 8 characters for registration", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Create an account" }).click();
    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toHaveAttribute("minLength", "8");
  });

  test("protected route redirects with a return destination", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    await expect(page.getByText("Sign in to continue to Settings.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Klorn" })).toBeVisible();
    await expect(page.getByText("No decision threads yet.")).toHaveCount(0);
  });
});
