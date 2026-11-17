import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Mail on a phone (mobile redesign PR3, MB1 "Editorial Brief", LOCKED
 * 2026-11-14). Below 600px the list opens with a row of lane chips, rows
 * carry a monogram, the sender, the subject and why the mail is in its lane,
 * and a row swipes: left is Later, right is Done. The reader is full screen:
 * a top bar, the subject and sender, a "why it rang" box for PUSH / MEETING,
 * the body, and Reply · Later · Done at the bottom. From 600px the split view
 * keeps the list beside the reader. Signed in with every API call mocked, like
 * today-mobile.spec.ts; the UI runs in Korean.
 */

const MINUTE = 60_000;

const SIGNED_IN_USER = {
  id: "user-1",
  email: "first-user@example.com",
  name: "First User",
  plan: "FREE",
  role: "USER",
  googleConnected: true,
  hasAnyMailSource: true,
  unifiedHome: true,
  mailV2: true,
};

function mail(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    gmailId: `g-${id}`,
    threadId: `t-${id}`,
    linkedInboxAccountId: null,
    senderEmail: null,
    trust: null,
    tier: "QUEUE",
    tierReason: null,
    to: "first-user@example.com",
    snippet: null,
    date: new Date(Date.now() - 20 * MINUTE).toISOString(),
    labels: [],
    isRead: false,
    isStarred: false,
    priority: "NORMAL",
    category: null,
    summary: null,
    keyPoints: [],
    actionItems: [],
    sentiment: null,
    needsReply: false,
    attachmentCount: 0,
    attachmentCandidateCount: 0,
    attachmentPendingCount: 0,
    attachmentFallbackCount: 0,
    attachmentUnsupportedCount: 0,
    attachmentCategories: [],
    candidateProfilePreview: null,
    candidateIntake: null,
    ...fields,
  };
}

const VERIFIED_V3 = {
  policyVersion: "v3.1",
  rank: null,
  held: false,
  due: null,
  threadTurn: "mine_to_reply",
  reasons: [
    {
      code: "ask",
      fact: null,
      evidence: "Please sign by 5pm today",
      evidenceIn: "body",
      params: {},
    },
  ],
};

const MAILS = [
  mail("e-1", {
    from: "Dana Park <dana@example.com>",
    subject: "Contract renewal",
    tier: "PUSH",
    tierReason: "Deadline today",
    v3: VERIFIED_V3,
  }),
  mail("e-2", {
    from: "Min Lee <min@example.com>",
    subject: "Q4 budget",
    tier: "PUSH",
    tierReason: "Your manager asked for a reply",
  }),
  mail("e-3", {
    from: "Weekly Digest <news@example.com>",
    subject: "This week in design",
    tier: "QUEUE",
    snippet: "Five links worth your time",
  }),
];

const LANE_COUNTS = {
  counts: {
    PUSH: { total: 5, unread: 2, threads: 5 },
    MEETING: { total: 1, unread: 0, threads: 1 },
    QUEUE: { total: 20, unread: 3, threads: 14 },
    INFO: { total: 9, unread: 0, threads: 9 },
    SILENT: { total: 30, unread: 0, threads: 30 },
  },
};

function detail(id: string) {
  const row = MAILS.find((item) => item.id === id) ?? MAILS[0];
  return {
    ...row,
    // No thread: the reader's thread panel is not under test here.
    threadId: null,
    cc: null,
    body: `Hello,\n\nThis is the body of ${String(row.subject)}.\n\nThanks`,
    renderHtml: null,
    unsubscribe: null,
    attachments: [],
  };
}

function readerContext(id: string) {
  const row = MAILS.find((item) => item.id === id) ?? MAILS[0];
  return {
    tier: row.tier,
    tierReason: row.tierReason,
    linkedInboxAccountId: null,
    firstContact: false,
    repliedCount: null,
    senderLabel: null,
    newerId: null,
    olderId: null,
    ...("v3" in row ? { v3: row.v3 } : {}),
  };
}

function apiBody(url: URL): unknown {
  const path = url.pathname;
  const fixed: Record<string, unknown> = {
    "/api/auth/me": { user: SIGNED_IN_USER },
    "/api/email": { emails: MAILS, source: "gmail", total: MAILS.length, unread: 3, page: 1 },
    "/api/email/lane-counts": LANE_COUNTS,
    "/api/email/inboxes": { inboxes: [] },
    "/api/email/bulk": { updated: 1 },
    "/api/notifications": { notifications: [] },
    "/api/notifications/alert-endpoints": { endpoints: [] },
    "/api/chat/conversations": { conversations: [] },
    "/api/chat/pending-actions": { actions: [] },
  };
  if (path in fixed) return fixed[path];
  const reader = /^\/api\/email\/(e-\d)(\/[a-z-]+)?$/.exec(path);
  if (reader) {
    const [, id, rest] = reader;
    if (!rest) return detail(id);
    if (rest === "/reader-context") return readerContext(id);
    if (rest === "/next") return { next: null };
  }
  return {};
}

async function signIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("klorn-token", "test-token");
    localStorage.setItem("klorn-profile", JSON.stringify({ language: "ko" }));
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(apiBody(url)) });
  });
}

async function openList(page: Page) {
  await signIn(page);
  await page.goto("/email");
  await expect(page.getByTestId("mail-row").first()).toBeVisible();
}

async function openReader(page: Page, id: string) {
  await signIn(page);
  await page.goto(`/email/${id}?markRead=false`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - window.innerWidth;
  });
}

function row(page: Page, subject: string): Locator {
  return page.getByTestId("mail-row").filter({ hasText: subject });
}

/** A one-finger horizontal swipe across a row, through the touch pipeline (pointerType "touch"). */
async function swipe(page: Page, target: Locator, fraction: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error("row not on screen");
  const y = box.y + box.height / 2;
  const startX = box.x + box.width / 2;
  const endX = startX + box.width * fraction;
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number) => [{ x, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(startX) });
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    const x = startX + ((endX - startX) * step) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test.use({ timezoneId: "Asia/Seoul" });
// The reader route compiles on first visit under `next dev`.
test.describe.configure({ timeout: 60_000 });

test.describe("phone 393×852", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

  test("lane chips: five lanes with counts, the active one pressed, a scroll row", async ({
    page,
  }) => {
    await openList(page);
    const chips = page.getByTestId("lane-chips");
    await expect(chips).toBeVisible();
    const lanes = chips.locator("[data-chip]:not([data-chip='ALL'])");
    await expect(lanes).toHaveCount(5);
    for (const [lane, count] of [
      ["Push", "5"],
      ["Meeting", "1"],
      ["Queue", "20"],
      ["Info", "9"],
      ["Silent", "30"],
    ]) {
      const chip = lanes.filter({ hasText: lane });
      await expect(chip).toContainText(count);
      const box = await chip.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    // The default view is Queue.
    await expect(lanes.filter({ hasText: "Queue" })).toHaveAttribute("aria-pressed", "true");
    await lanes.filter({ hasText: "Push" }).click();
    await expect(lanes.filter({ hasText: "Push" })).toHaveAttribute("aria-pressed", "true");
    await expect(lanes.filter({ hasText: "Queue" })).toHaveAttribute("aria-pressed", "false");

    const track = page.getByTestId("lane-chips-track");
    expect(await track.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    // More chips than the width: the end fades until it is scrolled to.
    await expect(track).toHaveAttribute("data-more-end", "true");
    const last = track.getByRole("button").last();
    await last.scrollIntoViewIfNeeded();
    const trackBox = await track.boundingBox();
    const lastBox = await last.boundingBox();
    expect((lastBox?.x ?? 0) + (lastBox?.width ?? 0)).toBeLessThanOrEqual(
      (trackBox?.x ?? 0) + (trackBox?.width ?? 0) + 1,
    );
    await expect(track).not.toHaveAttribute("data-more-end", "true");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("rows: monogram, sender, time, subject and why — quote, Klorn's call, or snippet", async ({
    page,
  }) => {
    await openList(page);
    const dana = row(page, "Contract renewal");
    await expect(dana.getByTestId("row-avatar")).toHaveText("DP");
    await expect(dana).toContainText("Dana Park");
    await expect(dana.locator("time")).toBeVisible();
    await expect(dana.getByTestId("row-why")).toHaveText("“Please sign by 5pm today”");
    await expect(row(page, "Q4 budget").getByTestId("row-why")).toHaveText(
      "Klorn 판단 · Your manager asked for a reply",
    );
    const digest = row(page, "This week in design");
    await expect(digest.getByTestId("row-why")).toHaveCount(0);
    await expect(digest).toContainText("Five links worth your time");

    for (const subject of ["Contract renewal", "Q4 budget", "This week in design"]) {
      const box = await row(page, subject).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    }
    const avatar = await dana.getByTestId("row-avatar").boundingBox();
    expect(Math.round(avatar?.width ?? 0)).toBe(34);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("swipe left asks for Later, swipe right is Done", async ({ page }) => {
    await openList(page);
    const later = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/email/e-2/later",
    );
    await swipe(page, row(page, "Q4 budget"), -0.45);
    await later;

    const done = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/email/bulk" &&
        (req.postData() ?? "").includes("e-1"),
    );
    await swipe(page, row(page, "Contract renewal"), 0.45);
    const request = await done;
    expect(JSON.parse(request.postData() ?? "{}")).toMatchObject({ action: "archive" });
  });

  test("with reduced motion a swipe still runs its action", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openList(page);
    const done = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/email/bulk",
    );
    await swipe(page, row(page, "Contract renewal"), 0.45);
    await done;
    const later = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/email/e-2/later",
    );
    await swipe(page, row(page, "Q4 budget"), -0.45);
    await later;
  });

  test("every swipe action is also a 44px button on touch", async ({ page }) => {
    await openList(page);
    const more = row(page, "Q4 budget").getByRole("button", { name: /Q4 budget/ });
    await expect(more).toBeVisible();
    const box = await more.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    await more.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: /^완료/ })).toBeVisible();
    const later = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/email/e-2/later",
    );
    await sheet.getByRole("button", { name: /^나중에/ }).click();
    await later;
    await expect(sheet).toBeHidden();
  });

  test("reader: verified quote in the why box, three 44px actions clear of the K button and tabs", async ({
    page,
  }) => {
    await openReader(page, "e-1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Contract renewal");
    const back = page.getByRole("navigation", { name: "메일로 돌아가기" }).getByRole("link");
    expect((await back.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("reader-assistant")).toBeVisible();

    const why = page.getByTestId("reader-why");
    await expect(why).toContainText("왜 울렸나");
    await expect(why.getByTestId("reader-why-text")).toHaveText("“Please sign by 5pm today”");

    const bar = page.getByRole("toolbar", { name: "메일 작업" });
    await expect(bar).toBeVisible();
    const barBox = await bar.boundingBox();
    if (!barBox) throw new Error("no action bar");
    for (const name of ["답장", "나중에", "완료"]) {
      const box = await bar.getByRole("button", { name, exact: true }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    // Nothing covers the bar: the floating K button and the tab bar stand down here.
    for (const covering of [
      page.getByRole("button", { name: "어시스턴트 열기" }).last(),
      page.getByTestId("bottom-tabs"),
    ]) {
      if (await covering.isVisible()) {
        const box = await covering.boundingBox();
        if (box) expect(overlaps(box, barBox)).toBe(false);
      }
    }
    await expect(page.getByTestId("bottom-tabs")).toBeHidden();
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(852);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("reader: the judge's own reason is Klorn's call; a Queue mail has no why box", async ({
    page,
  }) => {
    await openReader(page, "e-2");
    await expect(page.getByTestId("reader-why-text")).toHaveText(
      "Klorn 판단 · Your manager asked for a reply",
    );
    await page.goto("/email/e-3?markRead=false");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This week in design");
    await expect(page.getByTestId("reader-why")).toHaveCount(0);
  });

  test("reader: Later and Done send the existing requests", async ({ page }) => {
    await openReader(page, "e-1");
    const bar = page.getByRole("toolbar", { name: "메일 작업" });
    const later = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/email/e-1/later",
    );
    await bar.getByRole("button", { name: "나중에", exact: true }).click();
    await later;
    const done = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/email/e-1/archive",
    );
    await bar.getByRole("button", { name: "완료", exact: true }).click();
    await done;
  });
});

test.describe("tiny 344×882", () => {
  test.use({ viewport: { width: 344, height: 882 }, hasTouch: true, isMobile: true });

  test("list and reader fit", async ({ page }) => {
    await openList(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.goto("/email/e-1?markRead=false");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Contract renewal");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("split 690×900", () => {
  test.use({ viewport: { width: 690, height: 900 } });

  test("list beside the reader, no overflow", async ({ page }) => {
    await signIn(page);
    await page.goto("/email/e-1?markRead=false");
    await expect(page.getByTestId("mail-row").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Contract renewal" })).toBeVisible();
    const selected = row(page, "Contract renewal").locator("[aria-current='true']");
    await expect(selected).toHaveCount(1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("wide 1180×900", () => {
  test.use({ viewport: { width: 1180, height: 900 } });

  test("keeps the lane control and fits", async ({ page }) => {
    await openList(page);
    await expect(page.getByRole("radiogroup", { name: "레인" })).toBeVisible();
    await expect(page.getByTestId("lane-chips")).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
