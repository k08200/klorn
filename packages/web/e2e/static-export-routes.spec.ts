import { expect, type Page, test } from "@playwright/test";

/**
 * The static export on Cloudflare Pages (docs/deploy/cloudflare-pages.md):
 * every `/email/<id>`, `/calendar/<id>` and `/email/candidates/<id>` is served
 * by one prerendered shell (public/_redirects), so the page must take the id
 * from the address bar — on a cold deep link (a notification), on refresh,
 * and on in-app navigation between two ids. Also `/settings`, whose server
 * redirect became a client one.
 *
 * Runs only against a served static export, through Cloudflare's own
 * _headers/_redirects implementation; the API is mocked:
 *   pnpm --filter @klorn/web build:static
 *   (cd packages/web && pnpm dlx wrangler@4.48.0 pages dev out --port 8788)
 *   E2E_STATIC_EXPORT=1 E2E_BASE_URL=http://127.0.0.1:8788 \
 *     pnpm --filter @klorn/web exec playwright test e2e/static-export-routes.spec.ts
 */

test.skip(process.env.E2E_STATIC_EXPORT !== "1", "needs a served static export");

const EMAIL_ID = "0b6f9c1e-5d0e-4a51-9a39-2f0f7e8f1c11";
const OTHER_EMAIL_ID = "7a1d2c3b-0e9f-4b8a-8c7d-6e5f4a3b2c1d";
const EVENT_ID = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
/** The legacy reader's outer frame: rendered in its loading and error states alike. */
const READER_FRAME = 'div.max-w-5xl:has(> a[href="/email"])';

/** A signed-in user with mail; every API call is answered here and recorded. */
async function signedIn(page: Page) {
  const apiPaths: string[] = [];
  await page.addInitScript(() => localStorage.setItem("klorn-token", "e2e-test-token"));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    apiPaths.push(path);
    if (path === "/api/auth/me") {
      return route.fulfill({
        json: {
          user: {
            id: "u1",
            email: "operator@example.com",
            name: "Operator",
            plan: "PRO",
            role: "USER",
            timezone: "Asia/Seoul",
            googleConnected: true,
            googleNeedsReconnect: false,
            hasAnyMailSource: true,
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return apiPaths;
}

test.describe("static export: dynamic routes read the id from the URL", () => {
  test("a cold deep link to /email/<id> loads that email, and so does a refresh", async ({
    page,
  }) => {
    const apiPaths = await signedIn(page);
    // Served with the real _headers, so a CSP violation shows up here, as does
    // a shell whose prerender disagrees with its first client render.
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      const text = message.text();
      if (/Content Security Policy|Hydration|#418|#423|#425/i.test(text)) problems.push(text);
    });
    const response = await page.goto(`/email/${EMAIL_ID}`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    await expect.poll(() => apiPaths).toContain(`/api/email/${EMAIL_ID}`);

    apiPaths.length = 0;
    await page.reload();
    await expect.poll(() => apiPaths).toContain(`/api/email/${EMAIL_ID}`);
    await expect(page).toHaveURL(new RegExp(`/email/${EMAIL_ID}$`));
    expect(apiPaths.some((path) => path.startsWith("/api/email/_"))).toBe(false);
    expect(problems).toEqual([]);
  });

  test("in-app navigation between two emails swaps the id without a reload", async ({ page }) => {
    const apiPaths = await signedIn(page);
    await page.goto(`/email/${EMAIL_ID}`);
    await expect.poll(() => apiPaths).toContain(`/api/email/${EMAIL_ID}`);
    const frame = page.locator(READER_FRAME);
    await expect(frame).toHaveCount(1);
    await frame.evaluate((element) => element.setAttribute("data-before-nav", "1"));

    // The shell's RSC payload must come back as one, or Next falls back to a
    // full page load — the marker below would then be gone.
    const payload = page.waitForResponse((r) => r.url().includes(`/email/${OTHER_EMAIL_ID}.txt`));
    await page.evaluate((id) => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
      const next = (window as unknown as { next?: { router?: { push(href: string): void } } }).next;
      if (!next?.router) throw new Error("window.next.router is not exposed");
      next.router.push(`/email/${id}`);
    }, OTHER_EMAIL_ID);
    expect((await payload).headers()["content-type"]).toContain("text/plain");
    await expect.poll(() => apiPaths).toContain(`/api/email/${OTHER_EMAIL_ID}`);
    await expect(page).toHaveURL(new RegExp(`/email/${OTHER_EMAIL_ID}$`));
    // Both ids are the same "_" segment to the router; StaticRouteShell keys the
    // page by pathname so the second email starts from fresh state. The
    // reader's outer frame (marked before navigating) survives a mere refetch,
    // so it must be a new element now.
    await expect(page.locator(READER_FRAME)).toHaveCount(1);
    await expect(page.locator(`${READER_FRAME}[data-before-nav]`)).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true);
  });

  test("a meeting deep link to /calendar/<id> loads that event", async ({ page }) => {
    const apiPaths = await signedIn(page);
    await page.goto(`/calendar/${EVENT_ID}`);
    await expect.poll(() => apiPaths).toContain(`/api/calendar/${EVENT_ID}`);
  });

  test("/email/candidates/<id> loads that candidate, and /email/candidates is still the list", async ({
    page,
  }) => {
    const apiPaths = await signedIn(page);
    await page.goto(`/email/candidates/${EMAIL_ID}`);
    await expect.poll(() => apiPaths).toContain(`/api/email/${EMAIL_ID}`);

    // /email/:id would match "candidates" too; the passthrough rule keeps the
    // real list page (its own bundle), not the email shell.
    const list = await page.goto("/email/candidates");
    const html = (await list?.text()) ?? "";
    expect(html).toContain("static/chunks/app/email/candidates/page-");
    expect(html).not.toContain("page.static-");
  });

  test("/settings forwards to the first section with the query and fragment intact", async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto("/settings?google=ok#push");
    await expect(page).toHaveURL(/\/settings\/[a-z-]+\?google=ok#push$/);
  });
});
