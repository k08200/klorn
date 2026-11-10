import { expect, type Page, test } from "@playwright/test";

/**
 * A primary Google grant can die without the user doing anything: Google hands
 * back no refresh_token, the access token expires, and nothing can renew it.
 * The server has always known (`/api/auth/me` → googleNeedsReconnect) and the
 * web dropped the field on the floor, so five accounts in production sat with
 * a dead inbox and a background job retrying every 60s in silence.
 *
 * Two shapes, because the router treats them differently:
 *   - no other mail source → AuthGuard sends them to /onboarding, which was
 *     written for first-timers and reads like the account was reset
 *   - a linked IMAP inbox → they stay in the app, and nothing mentions it
 */

interface MeOverrides {
  googleConnected?: boolean;
  googleNeedsReconnect?: boolean;
  hasAnyMailSource?: boolean;
}

async function signedInAs(page: Page, overrides: MeOverrides) {
  // The real key is `klorn-token` (lib/api.ts AUTH_TOKEN_KEY). Writing the
  // wrong one silently leaves the page unauthenticated, which redirects to
  // /login — whose copy contains the word "Reconnect", so a loose assertion
  // passes against the wrong page entirely.
  await page.addInitScript(() => localStorage.setItem("klorn-token", "e2e-test-token"));
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "u1",
          email: "operator@example.com",
          name: "Operator",
          plan: "FREE",
          role: "USER",
          timezone: "Asia/Seoul",
          googleConnected: false,
          googleNeedsReconnect: false,
          hasAnyMailSource: false,
          ...overrides,
        },
      },
    }),
  );
  // Everything else the shell pulls on mount — kept empty so the assertions
  // are about the banner, not about data.
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/email/inboxes**", (route) => route.fulfill({ json: { inboxes: [] } }));
}

test.describe("Primary Gmail reconnect", () => {
  test("a returning user with a dead grant is told to reconnect, not welcomed", async ({
    page,
  }) => {
    await signedInAs(page, { googleNeedsReconnect: true, hasAnyMailSource: false });
    await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByTestId("google-reconnect-notice")).toBeVisible();
  });

  test("a genuine first-timer still gets the welcome, not a scare", async ({ page }) => {
    await signedInAs(page, { googleNeedsReconnect: false, hasAnyMailSource: false });
    await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByTestId("google-reconnect-notice")).toHaveCount(0);
  });

  test("a user who still has another inbox is warned inside the app", async ({ page }) => {
    // hasAnyMailSource true → no onboarding redirect, so the only way they
    // learn their primary Gmail stopped syncing is a banner.
    await signedInAs(page, { googleNeedsReconnect: true, hasAnyMailSource: true });
    await page.goto("/inbox");

    await expect(page.getByTestId("google-reconnect-banner")).toBeVisible();
  });

  test("a healthy account shows no banner", async ({ page }) => {
    await signedInAs(page, {
      googleConnected: true,
      googleNeedsReconnect: false,
      hasAnyMailSource: true,
    });
    await page.goto("/inbox");

    await expect(page.getByTestId("google-reconnect-banner")).toHaveCount(0);
  });
});
