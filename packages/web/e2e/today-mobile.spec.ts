import { expect, type Page, test } from "@playwright/test";

/**
 * Today on a phone (mobile redesign PR2, MB1 "Editorial Brief", LOCKED
 * 2026-11-14). Below 600px Today opens as a brief: the date and the day's
 * meetings, one headline counting the PUSH mail inside Today's 72h window,
 * the next events, a card per PUSH mail that says why it rang, and one quiet
 * line for the lanes Klorn sorted away. 600px and up keep the lanes layout.
 * Signed in with every API call mocked, like navigation.spec.ts; the UI runs
 * in Korean, the locale the board was drawn in.
 */

const MINUTE = 60_000;

const SIGNED_IN_USER = {
  id: "user-1",
  email: "first-user@example.com",
  name: "First User",
  plan: "FREE",
  role: "USER",
  googleConnected: false,
  hasAnyMailSource: true,
  unifiedHome: true,
  mailV2: true,
};

function pushMail(id: string, fields: Record<string, unknown>) {
  return {
    id,
    gmailId: `g-${id}`,
    threadId: `t-${id}`,
    linkedInboxAccountId: null,
    senderEmail: null,
    trust: null,
    tier: "PUSH",
    tierReason: null,
    to: "first-user@example.com",
    snippet: null,
    date: new Date(Date.now() - 20 * MINUTE).toISOString(),
    labels: [],
    isRead: false,
    isStarred: false,
    priority: "HIGH",
    category: null,
    summary: null,
    keyPoints: [],
    actionItems: [],
    sentiment: null,
    needsReply: true,
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

const PUSH_MAIL = [
  pushMail("e-1", {
    from: "Dana Park <dana@example.com>",
    subject: "Contract renewal",
    tierReason: "Deadline today",
    v3: {
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
    },
  }),
  pushMail("e-2", {
    from: "Min Lee <min@example.com>",
    subject: "Q4 budget",
    tierReason: "Your manager asked for a reply",
  }),
];

function calendarEvents() {
  const at = (offsetMin: number) => new Date(Date.now() + offsetMin * MINUTE).toISOString();
  return [
    {
      id: "c-1",
      title: "Weekly planning",
      startTime: at(-30),
      endTime: at(30),
      location: null,
      allDay: false,
    },
    {
      id: "c-2",
      title: "Design review",
      startTime: at(60),
      endTime: at(90),
      location: null,
      allDay: false,
    },
    {
      id: "c-3",
      title: "Partner call",
      startTime: at(120),
      endTime: at(150),
      location: null,
      allDay: false,
    },
  ];
}

const LANE_COUNTS = {
  counts: {
    PUSH: { total: 5, unread: 2, threads: 5 },
    MEETING: { total: 1, unread: 0, threads: 1 },
    QUEUE: { total: 20, unread: 3, threads: 14 },
    INFO: { total: 9, unread: 0, threads: 9 },
    SILENT: { total: 30, unread: 0, threads: 30 },
  },
};

function emailList(url: URL) {
  const tier = url.searchParams.get("tier");
  const empty = { emails: [], source: "gmail", total: 0, unread: 0, page: 1 };
  if (tier === "PUSH" && url.searchParams.get("window") === "today") {
    return { ...empty, emails: PUSH_MAIL, total: PUSH_MAIL.length, unread: 2 };
  }
  return empty;
}

async function openToday(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("klorn-token", "test-token");
    localStorage.setItem("klorn-profile", JSON.stringify({ language: "ko" }));
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const bodies: Record<string, () => unknown> = {
      "/api/auth/me": () => ({ user: SIGNED_IN_USER }),
      "/api/email": () => emailList(url),
      "/api/email/lane-counts": () => LANE_COUNTS,
      "/api/calendar": () => ({ events: calendarEvents() }),
      "/api/notifications": () => ({ notifications: [] }),
      "/api/notifications/alert-endpoints": () => ({ endpoints: [] }),
      "/api/chat/conversations": () => ({ conversations: [] }),
      "/api/chat/pending-actions": () => ({ actions: [] }),
      "/api/commitments": () => ({ commitments: [] }),
      "/api/briefing/status": () => ({
        date: new Date().toISOString().slice(0, 10),
        generated: false,
        note: null,
        notification: null,
        push: {
          state: "none",
          reason: null,
          deliveryId: null,
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
      }),
    };
    const body = bodies[url.pathname]?.() ?? {};
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/today");
  await expect(page.locator("#main")).toBeVisible();
}

function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - window.innerWidth;
  });
}

async function expectTarget(page: Page, name: string, index = 0) {
  const box = await page
    .getByTestId("brief-card")
    .nth(index)
    .getByRole("button", { name })
    .boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
}

test.use({ timezoneId: "Asia/Seoul" });

test.describe("phone 393×852", () => {
  test.use({ viewport: { width: 393, height: 852 } });

  test("headline counts Today's PUSH, cards say why, targets are 44px", async ({ page }) => {
    await openToday(page);
    const brief = page.getByTestId("today-brief");

    await expect(brief.getByRole("heading", { level: 1 })).toHaveText("지금 2건이 기다려요");
    await expect(page.getByTestId("brief-eyebrow")).toContainText("회의 3");

    const strip = page.getByTestId("brief-next-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByRole("listitem")).toHaveCount(3);
    await expect(strip.getByRole("listitem").first()).toContainText("지금");
    await expect(strip.getByRole("listitem").first()).toContainText("Weekly planning");
    await expect(strip.getByRole("listitem").nth(1)).toContainText("Design review");
    await expect(page.getByTestId("brief-next-line")).toHaveCount(0);

    const cards = page.getByTestId("brief-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Dana Park");
    await expect(cards.nth(1)).toContainText("Min Lee");
    // Verified evidence is a quote; the judge's own text is Klorn's call.
    await expect(cards.nth(0).getByTestId("brief-why")).toHaveText("“Please sign by 5pm today”");
    await expect(cards.nth(1).getByTestId("brief-why")).toHaveText(
      "Klorn 판단 · Your manager asked for a reply",
    );
    await expect(cards.nth(0)).toContainText("Contract renewal");
    await expect(cards.nth(0)).toContainText("Push");

    const reply = cards.nth(0).getByRole("link", { name: "답장" });
    const replyBox = await reply.boundingBox();
    expect(replyBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(reply).toHaveAttribute("href", /\/email\/e-1\?.*focus=reply/);
    await expectTarget(page, "나중에", 0);
    await expectTarget(page, "나중에", 1);

    const quiet = page.getByTestId("brief-quiet");
    await expect(quiet).toContainText("조용히 정리됨");
    await expect(quiet).toContainText("Queue 14");
    await expect(quiet).toContainText("Info 9");
    await expect(quiet).toContainText("Silent 30");

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("Later on a card sends the existing reminder request", async ({ page }) => {
    await openToday(page);
    const later = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/email/e-2/later",
    );
    await page.getByTestId("brief-card").nth(1).getByRole("button", { name: "나중에" }).click();
    await later;
  });
});

test.describe("tiny 344×882 (Fold cover)", () => {
  test.use({ viewport: { width: 344, height: 882 } });

  test("one-line next event and an icon-only Later", async ({ page }) => {
    await openToday(page);
    await expect(page.getByTestId("today-brief").getByRole("heading", { level: 1 })).toHaveText(
      "지금 2건이 기다려요",
    );
    await expect(page.getByTestId("brief-next-strip")).toHaveCount(0);
    const line = page.getByTestId("brief-next-line");
    await expect(line).toContainText("다음 ·");
    await expect(line).toContainText("Design review");

    const later = page.getByTestId("brief-card").first().getByRole("button", { name: "나중에" });
    await expect(later).toHaveAttribute("aria-label", "나중에");
    expect((await later.innerText()).trim()).toBe("");
    await expectTarget(page, "나중에", 0);

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

for (const width of [840, 1180]) {
  test.describe(`wide ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("keeps the lanes layout without overflow", async ({ page }) => {
      await openToday(page);
      await expect(page.locator("#today-lane-PUSH")).toBeVisible();
      await expect(page.getByTestId("today-brief")).toHaveCount(0);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
