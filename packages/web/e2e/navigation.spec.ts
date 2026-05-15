import { expect, type Page, test } from "@playwright/test";

async function mockSignedIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("jigeum-token", "test-token");
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const json = (body: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (path === "/api/auth/me") {
      return json({
        user: {
          id: "user-1",
          email: "first-user@example.com",
          name: "First User",
          plan: "FREE",
          role: "USER",
          googleConnected: false,
        },
      });
    }

    if (path === "/api/chat/conversations") {
      return json(
        method === "POST"
          ? { id: "thread-new" }
          : {
              conversations: [
                {
                  id: "thread-1",
                  title: "Investor follow-up",
                  pinned: false,
                  source: "user",
                  updatedAt: new Date().toISOString(),
                  _count: { messages: 1 },
                  pendingActionCount: 0,
                },
              ],
            },
      );
    }

    if (path === "/api/chat/pending-actions") return json({ actions: [] });
    if (path === "/api/commitments") return json({ commitments: [] });
    if (path === "/api/inbox/summary") {
      return json({ top3: [], today: { events: [], overdueTasks: [], todayTasks: [] } });
    }
    if (path === "/api/inbox/operating-plan") {
      return json({
        headline: "",
        mode: "observe",
        primaryAction: "",
        metrics: [],
        nextMoves: [],
        watchlist: [],
        outcomes: [],
      });
    }
    if (path === "/api/playbooks/recommendations") {
      return json({ generatedAt: "", playbooks: [], recommendations: [] });
    }
    if (path === "/api/work-graph/summary") return json({ generatedAt: "", contexts: [] });
    if (path === "/api/email") {
      return json({ emails: [], threads: [], source: "demo", total: 0, unread: 0 });
    }
    if (path === "/api/calendar") return json({ events: [] });
    if (path === "/api/notifications") return json({ notifications: [] });
    if (path === "/api/auth/google/status") return json({ connected: false });
    if (path === "/api/briefing/status") {
      return json({
        generated: false,
        note: null,
        push: {
          state: "not_sent",
          reason: null,
          acceptedAt: null,
          receivedAt: null,
          clickedAt: null,
        },
        automation: {
          configured: false,
          enabled: false,
          briefingTime: null,
          timezone: "Asia/Seoul",
          reason: "no_config",
        },
      });
    }

    return json({});
  });
}

test.describe("Navigation", () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => localStorage.clear()).catch(() => undefined);
    await page.goto("about:blank");
  });

  test("landing page nav has Log in and Early access", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation").getByRole("link", { name: "Log in" })).toBeVisible();
    await expect(
      page.getByRole("navigation").getByRole("link", { name: "Early access" }),
    ).toBeVisible();
  });

  test("clicking Log in navigates to login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("back to home link works from login", async ({ page }) => {
    await page.goto("/login");
    await page.click("text=Back to home");
    await expect(page).toHaveURL("/");
  });

  test("unauthenticated user cannot access dashboard", async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Finbox/);
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test("authenticated brand link returns to the decision queue", async ({ page }) => {
    await mockSignedIn(page);
    await page.goto("/chat");

    await expect(page.getByRole("link", { name: "Threads" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Files" })).toBeVisible();

    await page.getByRole("link", { name: "Open decision queue" }).click();
    await expect(page).toHaveURL(/\/inbox/);
    await expect(page.getByRole("heading", { name: /scattered signals/ })).toBeVisible();
  });

  test("mobile app navigation keeps the queue first and labels the current section", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSignedIn(page);

    await page.goto("/email");
    await expect(page.getByTestId("mobile-section-label")).toHaveText("Mail");

    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(nav.getByRole("link").first()).toHaveText("Queue");

    await page.goto("/calendar");
    await expect(page.getByTestId("mobile-section-label")).toHaveText("Calendar");
  });
});
