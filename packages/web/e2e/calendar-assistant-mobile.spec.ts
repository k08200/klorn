import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Calendar and the assistant on a phone (mobile redesign PR5, MB1 "Editorial
 * Brief"), plus the MB0 defects that were left:
 *
 * - Calendar below 600px opens on the day's agenda: a day header like
 *   Today's ("11월 18일 화요일 · 회의 2"), 44px previous / next day, rows with a
 *   time column, a 3px colour bar, the title and the place or meeting
 *   provider. A row opens a bottom sheet with the details and Join (an https
 *   link only). The month stays one tap away. From 600px nothing changes.
 * - The assistant opens full screen below 600px: its composer stays above the
 *   on-screen keyboard (visualViewport), the field is 16px (no iOS zoom), Send
 *   and Close are 44px, and the floating K button stands down while it is open.
 * - Overlays (the account sheet, New event) sit above the tab bar and the K
 *   button; the K button covers no control in Settings.
 * - The reply intent field has a neutral, localized example.
 * - Leaving a mail while the reply composer is open never leaves an extra
 *   history entry: Back does not land on the same mail twice.
 *
 * Signed in with every API call mocked; the UI runs in Korean, in Seoul time.
 */

const TIME_ZONE = "Asia/Seoul";
const DAY_MS = 86_400_000;

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

function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date);
}

const TODAY = dayKey(new Date());
const TOMORROW = new Date(Date.parse(`${TODAY}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

function longDate(key: string): string {
  return new Intl.DateTimeFormat("ko", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(`${key}T12:00:00Z`));
}

function event(id: string, title: string, key: string, from: string, to: string, extra = {}) {
  return {
    id,
    title,
    description: null,
    startTime: `${key}T${from}:00+09:00`,
    endTime: `${key}T${to}:00+09:00`,
    location: null,
    meetingLink: null,
    allDay: false,
    color: null,
    googleId: null,
    ...extra,
  };
}

const EVENTS = [
  event("ev-review", "디자인 리뷰", TODAY, "10:00", "11:00", {
    meetingLink: "https://meet.google.com/abc-defg-hij",
    color: "#4C8DFF",
  }),
  event("ev-partner", "Partner call", TODAY, "15:00", "15:30", {
    location: "Seoul office",
    meetingLink: "javascript:alert(1)",
  }),
  event("ev-holiday", "Team offsite", TODAY, "00:00", "23:59", { allDay: true }),
  event("ev-standup", "Tomorrow standup", TOMORROW, "09:00", "09:15"),
];

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
  body: "Hello,\n\nCould you confirm the renewal terms by Friday?\n\nThanks, Dana",
  renderHtml: null,
  unsubscribe: null,
  attachments: [],
};

function apiBody(path: string): unknown {
  const fixed: Record<string, unknown> = {
    "/api/auth/me": { user: SIGNED_IN_USER },
    "/api/auth/google/status": { connected: true },
    "/api/calendar": { events: EVENTS },
    "/api/notifications": { notifications: [] },
    "/api/notifications/alert-endpoints": { endpoints: [] },
    "/api/chat/conversations": { conversations: [] },
    "/api/chat/pending-actions": { actions: [] },
    "/api/email": { emails: [MAIL], source: "gmail", total: 1, unread: 0, page: 1 },
    "/api/email/inboxes": { inboxes: [] },
    "/api/email/e-1": MAIL,
    "/api/email/e-1/next": { next: null },
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

/**
 * A stand-in visualViewport the test can shrink, as the on-screen keyboard
 * does (Chromium has no keyboard to raise here).
 */
async function fakeVisualViewport(page: Page) {
  await page.addInitScript(() => {
    const target = new EventTarget();
    const box = { height: window.innerHeight, offsetTop: 0 };
    // Getters must stay getters (Object.assign would copy their first values).
    const viewport = Object.defineProperties(target, {
      height: { get: () => box.height },
      width: { get: () => window.innerWidth },
      offsetTop: { get: () => box.offsetTop },
      offsetLeft: { value: 0 },
      pageTop: { value: 0 },
      pageLeft: { value: 0 },
      scale: { value: 1 },
    });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard = (px) => {
      box.height = window.innerHeight - px;
      target.dispatchEvent(new Event("resize"));
    };
  });
}

async function signIn(page: Page) {
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
}

async function openCalendar(page: Page) {
  await signIn(page);
  await page.goto("/calendar");
  await expect(page.locator("#main")).toBeVisible();
}

const agenda = (page: Page) => page.getByTestId("calendar-agenda");
const eventSheet = (page: Page, title: string) => page.getByRole("dialog", { name: title });
const fab = (page: Page) => page.getByRole("button", { name: "어시스턴트 열기" });

async function expectTarget(locator: Locator, min = 44) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(min);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(min);
}

function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - window.innerWidth;
  });
}

/** What a tap at (x, y) would hit: the tab bar, the K button, an overlay, or another tag. */
async function topmostAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ([px, py]) => {
      const hit = document.elementFromPoint(px, py);
      if (!hit) return "nothing";
      if (hit.closest('[data-testid="bottom-tabs"]')) return "tabs";
      if (hit.closest('button[aria-label="어시스턴트 열기"]')) return "fab";
      if (hit.closest("[data-overlay]")) return "overlay";
      return hit.tagName.toLowerCase();
    },
    [x, y],
  );
}

async function expectOverlayOnTop(page: Page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  // The tab bar's strip and the K button's corner both belong to the overlay.
  expect(await topmostAt(page, 40, viewport.height - 20)).toBe("overlay");
  expect(await topmostAt(page, viewport.width - 40, viewport.height - 110)).toBe("overlay");
}

test.use({ timezoneId: TIME_ZONE, locale: "ko-KR" });

test.describe("phone calendar agenda (393 × 852)", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

  test("opens on today's agenda with a Today-style day header", async ({ page }) => {
    await openCalendar(page);
    await expect(agenda(page)).toBeVisible();
    await expect(page.getByTestId("calendar-day-eyebrow")).toHaveText(
      `${longDate(TODAY)} · 회의 2`,
    );
    const rows = agenda(page).getByRole("listitem");
    await expect(rows).toHaveCount(3);
    // All-day first, then by start time.
    await expect(rows.nth(0)).toContainText("종일");
    await expect(rows.nth(0)).toContainText("Team offsite");
    await expect(rows.nth(1)).toContainText("10:00");
    await expect(rows.nth(1)).toContainText("디자인 리뷰");
    await expect(rows.nth(1)).toContainText("Google Meet");
    await expect(rows.nth(2)).toContainText("15:00");
    await expect(rows.nth(2)).toContainText("Seoul office");
    // A 3px bar in the event's colour.
    const bar = rows.nth(1).getByTestId("agenda-bar");
    expect(await bar.evaluate((el) => el.getBoundingClientRect().width)).toBe(3);
    expect(await bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgb(76, 141, 255)",
    );
    for (const index of [0, 1, 2]) {
      expect(
        (await rows.nth(index).getByRole("button").boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    }
    // The cramped month is not the default on a phone.
    await expect(page.getByTestId("compact-month")).toBeHidden();
  });

  test("previous and next day are 44px and move the agenda", async ({ page }) => {
    await openCalendar(page);
    const next = page.getByRole("button", { name: "다음 날" });
    const prev = page.getByRole("button", { name: "이전 날" });
    await expectTarget(next);
    await expectTarget(prev);
    await next.click();
    await expect(page.getByTestId("calendar-day-eyebrow")).toHaveText(
      `${longDate(TOMORROW)} · 회의 1`,
    );
    await expect(agenda(page).getByRole("listitem")).toHaveCount(1);
    await expect(agenda(page)).toContainText("Tomorrow standup");
    await prev.click();
    await expect(page.getByTestId("calendar-day-eyebrow")).toContainText(longDate(TODAY));
    await next.click();
    await page.getByRole("button", { name: "오늘", exact: true }).click();
    await expect(page.getByTestId("calendar-day-eyebrow")).toContainText(longDate(TODAY));
  });

  test("an event opens a sheet with its details and a Join link for https only", async ({
    page,
  }) => {
    await openCalendar(page);
    await agenda(page)
      .getByRole("button", { name: /디자인 리뷰/ })
      .click();
    const sheet = eventSheet(page, "디자인 리뷰");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("sheet-handle")).toBeVisible();
    await expect(sheet).toContainText("10:00");
    await expect(sheet).toContainText("11:00");
    const join = sheet.getByRole("link", { name: /회의 참여/ });
    await expect(join).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
    await expect(join).toContainText("Google Meet");
    await expectTarget(join);
    await expectTarget(sheet.getByRole("button", { name: "닫기" }));
    await expectTarget(sheet.getByRole("link", { name: "일정 자세히 보기" }));
    // The sheet sits on the bottom edge, above the tab bar and the K button.
    const panel = await sheet.boundingBox();
    expect(Math.round((panel?.y ?? 0) + (panel?.height ?? 0))).toBe(852);
    await sheet.getByRole("button", { name: "닫기" }).click();
    await expect(sheet).toBeHidden();

    await agenda(page)
      .getByRole("button", { name: /Partner call/ })
      .click();
    const unsafe = eventSheet(page, "Partner call");
    await expect(unsafe).toBeVisible();
    await expect(unsafe).toContainText("Seoul office");
    await expect(unsafe.getByRole("link", { name: /회의 참여/ })).toHaveCount(0);
  });

  test("the month stays one tap away", async ({ page }) => {
    await openCalendar(page);
    const views = page.getByRole("group", { name: "보기" });
    await views.getByRole("button", { name: "월" }).click();
    await expect(page.getByTestId("compact-month")).toBeVisible();
    await expect(agenda(page)).toBeHidden();
    await views.getByRole("button", { name: "일정" }).click();
    await expect(agenda(page)).toBeVisible();
  });

  test("New event opens above the tab bar and the K button", async ({ page }) => {
    await openCalendar(page);
    await page.getByRole("button", { name: "새 일정" }).first().click();
    await expect(page.getByRole("dialog", { name: "새 일정" })).toBeVisible();
    await expectOverlayOnTop(page);
  });
});

test.describe("tiny phone calendar (344 × 882)", () => {
  test.use({ viewport: { width: 344, height: 882 }, hasTouch: true });

  test("the agenda fits the width", async ({ page }) => {
    await openCalendar(page);
    await expect(agenda(page)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expectTarget(page.getByRole("button", { name: "다음 날" }));
  });
});

test.describe("rail width calendar (690 × 840)", () => {
  test.use({ viewport: { width: 690, height: 840 } });

  test("keeps the month; no phone agenda", async ({ page }) => {
    await openCalendar(page);
    await expect(page.getByTestId("compact-month")).toBeVisible();
    await expect(agenda(page)).toBeHidden();
  });
});

test.describe("phone assistant (393 × 852)", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

  test("K opens a full-screen chat and stands down while it is open", async ({ page }) => {
    await openCalendar(page);
    await fab(page).click();
    const chat = page.getByRole("dialog", { name: "어시스턴트" });
    await expect(chat).toBeVisible();
    const box = await chat.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 393, height: 852 });
    await expect(fab(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "어시스턴트 닫기" })).toHaveCount(1);
    await expectTarget(chat.getByRole("button", { name: "어시스턴트 닫기" }));
    const field = chat.getByRole("textbox", { name: "어시스턴트에게 메시지 보내기" });
    expect(await field.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBe(16);
    await field.fill("내일 일정 알려줘");
    await expectTarget(chat.getByRole("button", { name: "보내기" }));
    // Suggestions and messages read at the phone body size, not the meta size.
    await chat.getByRole("button", { name: "어시스턴트 닫기" }).click();
    await expect(chat).toBeHidden();
    await expect(fab(page)).toBeVisible();
  });

  test("the composer stays above the on-screen keyboard", async ({ page }) => {
    await fakeVisualViewport(page);
    await openCalendar(page);
    await fab(page).click();
    const chat = page.getByRole("dialog", { name: "어시스턴트" });
    const send = chat.getByRole("button", { name: "보내기" });
    await expect(send).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(400),
    );
    await expect
      .poll(async () => {
        const b = await send.boundingBox();
        return (b?.y ?? 0) + (b?.height ?? 0);
      })
      .toBeLessThanOrEqual(452);
    const header = await chat.getByRole("button", { name: "어시스턴트 닫기" }).boundingBox();
    expect(header?.y ?? -1).toBeGreaterThanOrEqual(0);
  });

  test("the Assistant hub's chat keeps its composer above the keyboard", async ({ page }) => {
    await fakeVisualViewport(page);
    await signIn(page);
    await page.goto("/assistant/chat");
    const field = page.getByRole("textbox", { name: "어시스턴트에게 묻기" });
    await expect(field).toBeVisible();
    expect(await field.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBe(16);
    const send = page.getByRole("button", { name: "보내기" });
    await expectTarget(send);
    await page.evaluate(() =>
      (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(400),
    );
    await expect
      .poll(async () => {
        const b = await send.boundingBox();
        return (b?.y ?? 0) + (b?.height ?? 0);
      })
      .toBeLessThanOrEqual(452);
    await expect(field).toBeInViewport();
  });

  test("openAssistant() opens it full screen from the phone reader", async ({ page }) => {
    await signIn(page);
    await page.goto("/email/e-1?markRead=false");
    await expect(page.getByRole("heading", { level: 1, name: "Contract renewal" })).toBeVisible();
    await page.getByTestId("reader-assistant").click();
    const chat = page.getByRole("dialog", { name: "어시스턴트" });
    await expect(chat).toBeVisible();
    expect((await chat.boundingBox())?.height).toBe(852);
  });
});

test.describe("phone overlays and the K button (393 × 852)", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

  test("the account sheet sits above the tab bar and the K button", async ({ page }) => {
    await openCalendar(page);
    await page.getByTestId("phone-header").getByRole("button", { name: "계정 및 설정" }).click();
    await expect(page.getByRole("dialog", { name: "계정 및 설정" })).toBeVisible();
    await expectOverlayOnTop(page);
  });

  test("the K button covers no control in Settings", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");
    await expect(page.locator("#main")).toBeVisible();
    await expect(fab(page)).toBeVisible();
    // Walk Settings to the end; at every stop nothing interactive sits under K.
    const covered = await page.evaluate(async () => {
      const main = document.getElementById("main");
      const k = document.querySelector('button[aria-label="어시스턴트 열기"]');
      if (!main || !k) return ["setup"];
      const kBox = k.getBoundingClientRect();
      const hits: string[] = [];
      for (let top = 0; top <= main.scrollHeight; top += 200) {
        main.scrollTop = top;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        for (const el of main.querySelectorAll<HTMLElement>("a[href], button, input, select")) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;
          const overlap =
            b.left < kBox.right &&
            b.right > kBox.left &&
            b.top < kBox.bottom &&
            b.bottom > kBox.top;
          const fullyUnder =
            b.left >= kBox.left &&
            b.right <= kBox.right &&
            b.top >= kBox.top &&
            b.bottom <= kBox.bottom;
          // A control partly under K is fine while scrolling; one K hides whole is not,
          // and neither is one still under K when Settings is scrolled to its end.
          const atEnd = main.scrollTop + main.clientHeight >= main.scrollHeight - 1;
          if (fullyUnder || (atEnd && overlap)) {
            hits.push(el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName);
          }
        }
        if (main.scrollTop + main.clientHeight >= main.scrollHeight - 1) break;
      }
      return hits;
    });
    expect(covered).toEqual([]);
  });

  test("the reply intent field has a neutral example", async ({ page }) => {
    await signIn(page);
    await page.goto("/email/e-1?markRead=false");
    await expect(page.getByRole("heading", { level: 1, name: "Contract renewal" })).toBeVisible();
    await page
      .getByRole("toolbar", { name: "메일 작업" })
      .getByRole("button", { name: "답장" })
      .click();
    const intent = page.getByRole("dialog", { name: "답장" }).getByRole("textbox", {
      name: "답장에 담을 내용",
    });
    await expect(intent).toBeVisible();
    const placeholder = (await intent.getAttribute("placeholder")) ?? "";
    expect(placeholder).not.toMatch(/오디션|캐스팅|프로필/);
    expect(placeholder.length).toBeGreaterThan(0);
  });
});

test.describe("leaving a mail with the composer open (half-folded 412 × 915)", () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });

  test("Back never lands on the same mail twice", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 1,
      mobile: true,
      displayFeature: { orientation: "horizontal", offset: 445, maskLength: 25 },
    });
    await signIn(page);
    await page.goto("/email");
    await page.goto("/email/e-1?markRead=false");
    await expect(page.getByRole("heading", { level: 1, name: "Contract renewal" })).toBeVisible();
    await page
      .getByRole("toolbar", { name: "메일 작업" })
      .getByRole("button", { name: "답장" })
      .click();
    await expect(page.getByRole("dialog", { name: "답장" })).toBeVisible();
    // The composer is non-modal here: leave through the reader's own back link.
    await page.getByRole("navigation").getByRole("link", { name: /메일/ }).first().click();
    await expect(page).toHaveURL(/\/email(\?.*)?$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/email\/e-1/);
    await page.goBack();
    await expect(page).toHaveURL(/\/email(\?.*)?$/);
  });
});
