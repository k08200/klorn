import { expect, type Page, test } from "@playwright/test";
import en from "../src/lib/locales/en";

/**
 * Issue #1727 — a stale token must not bounce a visitor off a public page.
 *
 * `AuthProvider` sits in the root layout, so on EVERY route it reads the stored
 * token and probes `/api/auth/me`. `apiFetch` answers a 401 on that probe by
 * clearing the token and sending the browser to
 * `/login?error=session_expired&next=…` — which is right for a page that needs
 * a session and wrong for one that does not. /playground is public by design
 * (no signup, no key since #1714) and is the link in the X and LinkedIn posts
 * and the awesome-selfhosted demo_url, so the people it turns away are the ones
 * who signed up once or whose token aged out.
 *
 * Protection in this app is opt-in per route via AuthGuard, so the fix is not a
 * list of public paths: the bootstrap probe simply stops redirecting, and the
 * guard keeps doing its job on the routes that asked for it.
 *
 * The API is mocked, so nothing else needs to be up:
 *   E2E_BASE_URL=http://localhost:<port> pnpm exec playwright test e2e/public-routes-stale-session.spec.ts
 * A fresh machine needs `pnpm exec playwright install chromium` first, or all
 * tests fail in ~1ms with "Executable doesn't exist", which reads like a broken
 * import rather than a missing browser. Never use port 8001: the config sets
 * `reuseExistingServer`, so Playwright will test whatever stale tree is there.
 */

const STALE_TOKEN = "stale.jwt.value";

/** Leave a token behind the way a previous visit would have. */
async function seedStaleToken(page: Page) {
  await page.addInitScript((token) => {
    localStorage.setItem("klorn-token", token);
  }, STALE_TOKEN);
}

/** Every API call 401s, as it would for a token the server no longer honours. */
async function expireTheSession(page: Page) {
  const probes: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    probes.push(path);
    return route.fulfill({ status: 401, json: { error: "unauthorized" } });
  });
  return probes;
}

const token = (page: Page) => page.evaluate(() => localStorage.getItem("klorn-token"));

test.describe("a stale session does not withhold a public page", () => {
  test("/playground renders instead of bouncing to /login", async ({ page }) => {
    await seedStaleToken(page);
    const probes = await expireTheSession(page);

    await page.goto("/playground");
    await page.waitForLoadState("networkidle");

    // The whole point of the page: it needs no account, so a dead account is
    // not a reason to withhold it.
    await expect(page).toHaveURL(/\/playground/);
    await expect(page.getByRole("button", { name: en["playground.submit"] })).toBeVisible();
    // It really did probe — otherwise this test would pass for the wrong reason.
    expect(probes.some((p) => p.includes("/api/auth/me"))).toBe(true);
  });

  test("the dead token is dropped, so the next visit does not probe again", async ({ page }) => {
    await seedStaleToken(page);
    await expireTheSession(page);

    await page.goto("/playground");
    await page.waitForLoadState("networkidle");

    // An expired token is a reason to drop the token, not to withhold a page.
    expect(await token(page)).toBeNull();
  });

  test("no session-expired message reaches a visitor who asked for no session", async ({
    page,
  }) => {
    await seedStaleToken(page);
    await expireTheSession(page);

    await page.goto("/playground");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).not.toContain(en["auth.sessionExpired"]);
    expect(page.url()).not.toContain("error=session_expired");
  });

  test("the key-free demo still works for a visitor who arrived with a stale token", async ({
    page,
  }) => {
    await seedStaleToken(page);
    // 401 everything EXCEPT the public classify route, which takes no session.
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/api/playground/classify")) {
        return route.fulfill({
          status: 200,
          json: {
            tier: "QUEUE",
            reason: "Colleague asking for same-day contract sign-off",
            features: { confidence: 0.6, senderTrust: 0.9, reversibility: 0.4, urgency: 0.9 },
            source: "llm",
            model: "claude-haiku-5-5",
          },
        });
      }
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    });

    await page.goto("/playground");
    await page.getByRole("button", { name: en["playground.submit"] }).click();

    await expect(page.getByText(en["playground.headline.QUEUE"])).toBeVisible();
  });
});

test.describe("a stale session still sends you to login where a session is required", () => {
  test("/assistant redirects, and still says the session expired", async ({ page }) => {
    await seedStaleToken(page);
    await expireTheSession(page);

    await page.goto("/assistant");
    await page.waitForURL(/\/login/);

    // AuthGuard owns this redirect. The reason must survive the fix, or an
    // expired session becomes a silent bounce for the users it is aimed at.
    expect(page.url()).toContain("error=session_expired");
    expect(decodeURIComponent(page.url())).toContain("next=/assistant");
  });
});
