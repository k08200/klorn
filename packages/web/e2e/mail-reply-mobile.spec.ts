import { expect, type Page, type Request, test } from "@playwright/test";

/**
 * Reply on a phone (mobile redesign PR4). Below 600px the reader's Reply opens
 * a bottom sheet: a drag handle, a 44px close, the draft shown in full (the
 * text box grows; nothing is cut off) and editable, the original message
 * folded under a disclosure, and Send (44px) on the sheet's bottom edge, still
 * on screen when the viewport shrinks for the keyboard. Closing keeps the
 * draft. On a half-folded screen (two vertical viewport segments) the reader
 * stays on the top segment and the composer takes the bottom one, starting
 * below the hinge. From 600px the reply box stays inline, as before. Signed in
 * with every API call mocked, like mail-mobile.spec.ts; the UI runs in Korean.
 */

const SIGNED_IN_USER = {
  id: "user-1",
  email: "first-user@example.com",
  name: "First User",
  plan: "PRO",
  role: "USER",
  googleConnected: true,
  hasAnyMailSource: true,
  unifiedHome: true,
  mailV2: true,
};

const ORIGINAL_BODY = "Hello,\n\nCould you confirm the renewal terms by Friday?\n\nThanks, Dana";

const MAIL = {
  id: "e-1",
  gmailId: "g-e-1",
  threadId: null,
  linkedInboxAccountId: null,
  senderEmail: "dana@example.com",
  trust: null,
  from: "Dana Park <dana@example.com>",
  subject: "Contract renewal",
  tier: "QUEUE",
  tierReason: null,
  to: "first-user@example.com",
  cc: null,
  snippet: "Could you confirm the renewal terms",
  date: new Date(Date.now() - 20 * 60_000).toISOString(),
  labels: [],
  isRead: true,
  isStarred: false,
  priority: "NORMAL",
  category: null,
  summary: null,
  keyPoints: [],
  actionItems: [],
  sentiment: null,
  needsReply: false,
  body: ORIGINAL_BODY,
  renderHtml: null,
  unsubscribe: null,
  attachments: [],
};

/** Long enough that a fixed-height text box would cut it off. */
const DRAFT_LINES = Array.from(
  { length: 24 },
  (_, i) => `Line ${i + 1}: the renewal terms look right to me.`,
);
const DRAFT = {
  to: "dana@example.com",
  subject: "Re: Contract renewal",
  body: DRAFT_LINES.join("\n"),
};

function apiBody(path: string): unknown {
  const fixed: Record<string, unknown> = {
    "/api/auth/me": { user: SIGNED_IN_USER },
    "/api/email": { emails: [MAIL], source: "gmail", total: 1, unread: 0, page: 1 },
    "/api/email/inboxes": { inboxes: [] },
    "/api/notifications": { notifications: [] },
    "/api/notifications/alert-endpoints": { endpoints: [] },
    "/api/chat/conversations": { conversations: [] },
    "/api/chat/pending-actions": { actions: [] },
    "/api/email/e-1": MAIL,
    "/api/email/e-1/next": { next: null },
    "/api/email/e-1/reply-draft": DRAFT,
    "/api/email/send": { sent: true },
    "/api/email/e-1/reader-context": {
      tier: "QUEUE",
      tierReason: null,
      linkedInboxAccountId: null,
      firstContact: false,
      repliedCount: null,
      senderLabel: null,
      newerId: null,
      olderId: null,
    },
  };
  return fixed[path] ?? {};
}

async function openReader(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("klorn-token", "test-token");
    localStorage.setItem("klorn-profile", JSON.stringify({ language: "ko" }));
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(apiBody(url.pathname)),
    });
  });
  await page.goto("/email/e-1?markRead=false");
  await expect(page.getByRole("heading", { level: 1, name: "Contract renewal" })).toBeVisible();
}

const replyButton = (page: Page) =>
  page.getByRole("toolbar", { name: "메일 작업" }).getByRole("button", { name: "답장" });
const sheet = (page: Page) => page.getByRole("dialog", { name: "답장" });
const draftBox = (page: Page) => sheet(page).getByRole("textbox", { name: "답장 본문" });
const sendButton = (page: Page) => sheet(page).getByRole("button", { name: "이 답장 보내기" });

async function openSheetWithDraft(page: Page) {
  await replyButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole("button", { name: "답장 초안 작성" }).click();
  await expect(draftBox(page)).toHaveValue(DRAFT.body);
}

/** True when the text box shows all of its text (no inner scroll, nothing clipped). */
function showsAllText(page: Page): Promise<boolean> {
  return draftBox(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
}

async function expectInViewport(page: Page, selector: ReturnType<typeof sendButton>) {
  const box = await selector.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
}

test.describe("phone reply sheet (393 × 852)", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

  test("Reply rises as a sheet with a handle, a 44px close and no inline reply box", async ({
    page,
  }) => {
    await openReader(page);
    // The phone reader has no inline reply box: Reply is the way in.
    await expect(page.getByRole("button", { name: "답장 초안 작성" })).toHaveCount(0);
    await replyButton(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByTestId("sheet-handle")).toBeVisible();
    const close = sheet(page).getByRole("button", { name: "닫기" });
    const closeBox = await close.boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    // The sheet sits on the bottom edge.
    const panel = await sheet(page).boundingBox();
    expect(Math.round((panel?.y ?? 0) + (panel?.height ?? 0))).toBe(852);
  });

  test("an AI draft is shown in full and editable, with a 44px Send in view", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    expect(await showsAllText(page)).toBe(true);
    await draftBox(page).fill(`${DRAFT.body}\nOne more line I typed.`);
    expect(await showsAllText(page)).toBe(true);
    const send = sendButton(page);
    await expect(send).toBeVisible();
    expect((await send.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expectInViewport(page, send);
    // The Send row is flush with the sheet's bottom edge: no draft text below it.
    const sendRow = await send.evaluate(
      (el) => el.parentElement?.parentElement?.getBoundingClientRect().bottom ?? 0,
    );
    const panel = await sheet(page).boundingBox();
    expect(Math.abs(sendRow - ((panel?.y ?? 0) + (panel?.height ?? 0)))).toBeLessThanOrEqual(1);
  });

  test("Send posts exactly the confirmed text through the existing send path", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    const edited = `${DRAFT.body}\nSee you Friday.`;
    await draftBox(page).fill(edited);
    const sent = page.waitForRequest(
      (request: Request) =>
        request.method() === "POST" && new URL(request.url()).pathname === "/api/email/send",
    );
    await sendButton(page).click();
    const body = (await sent).postDataJSON();
    expect(body).toEqual({
      to: DRAFT.to,
      subject: DRAFT.subject,
      body: edited,
      inReplyToEmailId: "e-1",
    });
    // Sent: the sheet closes and says so.
    await expect(sheet(page)).toBeHidden();
    await expect(page.getByText("메일을 보냈습니다")).toBeVisible();
  });

  test("a failed send is shown inside the sheet and the draft stays", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    await page.route("**/api/email/send", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "boom" }),
      }),
    );
    await sendButton(page).click();
    await expect(sheet(page).getByRole("alert")).toBeVisible();
    await expect(draftBox(page)).toHaveValue(DRAFT.body);
  });

  test("?focus=reply opens the sheet on a phone", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("klorn-token", "test-token");
      localStorage.setItem("klorn-profile", JSON.stringify({ language: "ko" }));
    });
    await page.route("**/api/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(apiBody(new URL(route.request().url()).pathname)),
      }),
    );
    await page.goto("/email/e-1?markRead=false&focus=reply");
    await expect(sheet(page)).toBeVisible();
  });

  test("Send stays on screen when the viewport shrinks for the keyboard", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    await draftBox(page).focus();
    // The keyboard takes ~400px: the layout viewport shrinks (resizes-content).
    await page.setViewportSize({ width: 393, height: 452 });
    await expect(sendButton(page)).toBeVisible();
    await expectInViewport(page, sendButton(page));
  });

  test("the original message is folded under a disclosure", async ({ page }) => {
    await openReader(page);
    await replyButton(page).click();
    const original = sheet(page).locator("details", { hasText: "원본 메일" });
    await expect(original).toHaveCount(1);
    await expect(original).not.toHaveAttribute("open", "");
    await expect(
      sheet(page).getByText("Could you confirm the renewal terms by Friday?"),
    ).toBeHidden();
    await original.locator("summary").click();
    await expect(
      sheet(page).getByText("Could you confirm the renewal terms by Friday?"),
    ).toBeVisible();
  });

  test("closing keeps the draft and returns focus to Reply", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    const edited = `${DRAFT.body}\nKept after closing.`;
    await draftBox(page).fill(edited);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await expect(replyButton(page)).toBeFocused();
    await replyButton(page).click();
    await expect(draftBox(page)).toHaveValue(edited);
    await sheet(page).getByRole("button", { name: "닫기" }).click();
    await expect(sheet(page)).toBeHidden();
    await replyButton(page).click();
    await expect(draftBox(page)).toHaveValue(edited);
  });

  test("Back closes the sheet without leaving the mail or losing the draft", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    const edited = `${DRAFT.body}\nKept after Back.`;
    await draftBox(page).fill(edited);
    await page.goBack();
    await expect(sheet(page)).toBeHidden();
    await expect(page).toHaveURL(/\/email\/e-1/);
    await expect(page.getByRole("heading", { level: 1, name: "Contract renewal" })).toBeVisible();
    await replyButton(page).click();
    await expect(draftBox(page)).toHaveValue(edited);
    // Closing with the button takes the extra history entry off again.
    await sheet(page).getByRole("button", { name: "닫기" }).click();
    await expect(sheet(page)).toBeHidden();
    expect(await page.evaluate(() => window.history.state?.klornReplyComposer)).toBeUndefined();
  });

  test("Tab stays inside the sheet", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') !== null,
      );
      expect(inside).toBe(true);
    }
  });

  test("reduced motion drops the slide", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openReader(page);
    await replyButton(page).click();
    const motion = await sheet(page).evaluate((el) => {
      const style = getComputedStyle(el);
      return { duration: Number.parseFloat(style.transitionDuration), translate: style.translate };
    });
    // No slide (motion-safe:translate-y-full never applies) and an instant swap.
    expect(["none", "0px"]).toContain(motion.translate);
    expect(motion.duration).toBeLessThan(0.01);
  });
});

test.describe("tiny phone (344 × 882)", () => {
  test.use({ viewport: { width: 344, height: 882 }, hasTouch: true });

  test("the sheet fits the width and Send is reachable", async ({ page }) => {
    await openReader(page);
    await openSheetWithDraft(page);
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return root.scrollWidth - window.innerWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await showsAllText(page)).toBe(true);
    await expectInViewport(page, sendButton(page));
  });
});

test.describe("rail width (700 × 900)", () => {
  test.use({ viewport: { width: 700, height: 900 } });

  test("the reply box stays inline; no sheet", async ({ page }) => {
    await openReader(page);
    await expect(page.getByRole("button", { name: "답장 초안 작성" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("half-folded (two vertical segments, 412 × 915, hinge at 445–470)", () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });

  const HINGE_TOP = 445;
  const HINGE_BOTTOM = 470;

  test("reader on the top segment, composer on the bottom one, nothing under the hinge", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 1,
      mobile: true,
      displayFeature: {
        orientation: "horizontal",
        offset: HINGE_TOP,
        maskLength: HINGE_BOTTOM - HINGE_TOP,
      },
    });
    await openReader(page);
    expect(await page.evaluate(() => matchMedia("(vertical-viewport-segments: 2)").matches)).toBe(
      true,
    );
    await replyButton(page).click();
    const composer = page.getByRole("dialog", { name: "답장" });
    await expect(composer).toBeVisible();
    // Non-modal: the reader stays usable on the top segment.
    await expect(composer).not.toHaveAttribute("aria-modal", "true");
    const panel = await composer.boundingBox();
    expect(Math.round(panel?.y ?? 0)).toBe(HINGE_TOP);
    expect(Math.round((panel?.y ?? 0) + (panel?.height ?? 0))).toBe(915);
    // The composer's content starts below the hinge.
    const close = await composer.getByRole("button", { name: "닫기" }).boundingBox();
    expect(close?.y ?? 0).toBeGreaterThanOrEqual(HINGE_BOTTOM);
    // The subject is on the top segment, above the hinge.
    const heading = await page
      .getByRole("heading", { level: 1, name: "Contract renewal" })
      .boundingBox();
    expect((heading?.y ?? 0) + (heading?.height ?? 0)).toBeLessThanOrEqual(HINGE_TOP);
    await composer.getByRole("button", { name: "답장 초안 작성" }).click();
    await expect(composer.getByRole("textbox", { name: "답장 본문" })).toHaveValue(DRAFT.body);
    const send = await composer.getByRole("button", { name: "이 답장 보내기" }).boundingBox();
    expect(send?.y ?? 0).toBeGreaterThanOrEqual(HINGE_BOTTOM);
    expect((send?.y ?? 0) + (send?.height ?? 0)).toBeLessThanOrEqual(915);
    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();
  });
});
