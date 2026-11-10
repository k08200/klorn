/**
 * Mail behaviour against the mock API: Done's client-side undo window, the
 * lane move and its server undo, pinning, Later, the explicit send with its
 * receipt, Subscriptions, dark routes, sheets' keyboard handling, deep links.
 */
import { expect, type Page, test } from "@playwright/test";
import { openApp, settle } from "./helpers";
import { mockState, swipe } from "./mail-helpers";

async function phone(page: Page, path: string, scenario = "default") {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, path, { scenario, insets: "47,0,34,0" });
  await settle(page);
}

const row = (page: Page, name: RegExp) => page.getByRole("link", { name }).first();

test("swipe right: the row leaves at once, dismiss is sent only after the 5 s window", async ({
  page,
}) => {
  await phone(page, "/mail");
  await swipe(page, row(page, /한끼배달/), 160);
  await expect(row(page, /한끼배달/)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "처리 완료" })).toBeVisible();
  expect((await mockState(page)).dismissed).toEqual([]);
  await page.clock.runFor(5_200);
  await expect.poll(async () => (await mockState(page)).dismissed).toEqual(["att-info-1"]);
  await expect(page.getByRole("status").filter({ hasText: "처리 완료" })).toHaveCount(0);
});

test("undo inside the window brings the row back and sends nothing", async ({ page }) => {
  await phone(page, "/mail");
  await swipe(page, row(page, /한끼배달/), 160);
  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect(row(page, /한끼배달/)).toBeVisible();
  await page.clock.runFor(6_000);
  expect((await mockState(page)).dismissed).toEqual([]);
});

test("a short drag springs back and changes nothing", async ({ page }) => {
  await phone(page, "/mail");
  await swipe(page, row(page, /한끼배달/), 40, 20);
  await expect(row(page, /한끼배달/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("swipe left → SILENT preselected → move; undo goes through the server's undo route", async ({
  page,
}) => {
  await phone(page, "/mail");
  await swipe(page, row(page, /한끼배달/), -160);
  const sheet = page.getByRole("dialog", { name: "레인 옮기기" });
  await expect(sheet.getByRole("radio", { name: /SILENT/ })).toBeChecked();
  await sheet.getByRole("button", { name: "SILENT로 옮기기" }).click();
  await expect(sheet).toHaveCount(0);
  // SILENT is recorded, never rendered in 전체: the row leaves the list.
  await expect(row(page, /한끼배달/)).toHaveCount(0);
  expect((await mockState(page)).tiers).toEqual([["email-att-info-1", "SILENT"]]);
  await page.getByRole("button", { name: "실행 취소" }).click();
  await expect(row(page, /한끼배달/)).toBeVisible();
  await expect
    .poll(async () => (await mockState(page)).tiers)
    .toEqual([["email-att-info-1", "INFO"]]);
});

test("'keep this sender here' pins the sender to the chosen lane", async ({ page }) => {
  await phone(page, "/mail");
  await swipe(page, row(page, /한끼배달/), -160);
  const sheet = page.getByRole("dialog", { name: "레인 옮기기" });
  await sheet.getByRole("switch", { name: /한끼배달 메일은 앞으로도 여기로/ }).check();
  await sheet.getByRole("button", { name: "SILENT로 옮기기" }).click();
  await expect
    .poll(async () => (await mockState(page)).pins)
    .toEqual([{ emailId: "email-att-info-1", tier: "SILENT" }]);
});

test("moving the same sender to the same lane again opens with the pin on", async ({ page }) => {
  await phone(page, "/mail");
  const sheet = page.getByRole("dialog", { name: "레인 옮기기" });
  const pin = sheet.getByRole("switch", { name: /한끼배달 메일은 앞으로도 여기로/ });
  // First move: the toggle starts off.
  await swipe(page, row(page, /한끼배달/), -160);
  await expect(pin).not.toBeChecked();
  await sheet.getByRole("radio", { name: /QUEUE/ }).check();
  await sheet.getByRole("button", { name: "QUEUE로 옮기기" }).click();
  await expect(sheet).toHaveCount(0);
  expect((await mockState(page)).pins).toEqual([]);
  // Second time: the swipe preselects SILENT (a different lane), so still off …
  await swipe(page, row(page, /한끼배달/), -160);
  await expect(sheet.getByRole("radio", { name: /SILENT/ })).toBeChecked();
  await expect(pin).not.toBeChecked();
  // … and choosing the same lane as last time turns it on by itself.
  await sheet.getByRole("radio", { name: /QUEUE/ }).check();
  await expect(pin).toBeChecked();
  // The user can still say no, and then the suggestion stops steering it.
  await pin.uncheck();
  await sheet.getByRole("radio", { name: /INFO/ }).check();
  await sheet.getByRole("radio", { name: /QUEUE/ }).check();
  await expect(pin).not.toBeChecked();
  await pin.check();
  await sheet.getByRole("button", { name: "이 발신자 고정하기" }).click();
  await expect
    .poll(async () => (await mockState(page)).pins)
    .toEqual([{ emailId: "email-att-info-1", tier: "QUEUE" }]);
});

test("with KEYBOARD_TRIAGE dark the move falls back to the older route, without undo", async ({
  page,
}) => {
  await phone(page, "/mail", "flagsOff");
  await swipe(page, row(page, /박서연/), -160);
  const sheet = page.getByRole("dialog", { name: "레인 옮기기" });
  await sheet.getByRole("radio", { name: /QUEUE/ }).check();
  await sheet.getByRole("button", { name: "QUEUE로 옮기기" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "QUEUE 레인으로 옮겼어요" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "실행 취소" })).toHaveCount(0);
  expect((await mockState(page)).tiers).toEqual([["email-att-push-1", "QUEUE"]]);
});

test("long press starts multi-select; bulk Done clears every selected row", async ({ page }) => {
  await phone(page, "/mail");
  const box = await row(page, /Mark Chen/).boundingBox();
  if (!box) throw new Error("row");
  await page.mouse.move(box.x + 120, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(600);
  await page.mouse.up();
  await row(page, /한끼배달/).click();
  await expect(page.getByText("2개 선택됨")).toBeVisible();
  await page
    .getByRole("toolbar", { name: "선택한 메일 동작" })
    .getByRole("button", { name: "처리 완료" })
    .click();
  await expect(row(page, /Mark Chen/)).toHaveCount(0);
  await expect(row(page, /한끼배달/)).toHaveCount(0);
  await page.clock.runFor(5_200);
  await expect
    .poll(async () => (await mockState(page)).dismissed.sort())
    .toEqual(["att-info-1", "att-meet-1"]);
});

test("every swipe action has a button path (row actions sheet), and Escape closes it", async ({
  page,
}) => {
  await phone(page, "/mail");
  const actions = page.getByRole("button", { name: /포트폴리오 피드백 부탁드려요 동작/ });
  await actions.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "메일 동작" });
  await expect(sheet.getByRole("button", { name: /처리 완료/ })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /레인 옮기기/ })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /나중에/ })).toBeVisible();
  // Focus is trapped in the sheet.
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(actions).toBeFocused();
});

test("Later hides the mail until the chosen time and snoozes its attention item", async ({
  page,
}) => {
  await phone(page, "/mail/email-att-meet-1");
  await page.getByRole("button", { name: "나중에" }).click();
  await page.getByRole("button", { name: /내일 아침/ }).click();
  await expect(page).toHaveURL(/\/mail$/);
  await expect(row(page, /Mark Chen/)).toHaveCount(0);
  await page.clock.runFor(5_200);
  await expect
    .poll(async () => (await mockState(page)).snoozed.map(([id]) => id))
    .toEqual(["att-meet-1"]);
});

test("send is explicit: the confirm sheet shows exactly what goes out, then a receipt", async ({
  page,
}) => {
  await phone(page, "/mail/email-att-push-1");
  await page.getByRole("button", { name: "고쳐 쓰기" }).click();
  const composer = page.getByRole("dialog", { name: "답장" });
  await composer.getByRole("button", { name: "더 짧게" }).click();
  await expect(composer.getByLabel("답장 내용")).toHaveValue(
    "서연님, 3조·7조 확인했어요. 오늘 4시 전에 서명해서 보낼게요.",
  );
  await composer.getByLabel("답장 내용").fill("서연님, 확인했어요. 4시 전에 보낼게요.");
  await composer.getByRole("button", { name: "보내기 검토" }).click();
  const confirm = page.getByRole("dialog", { name: "보내기 전에 확인" });
  await expect(confirm).toContainText("seoyeon@hanbitpartners.example");
  await expect(confirm).toContainText("Re: 계약서 수정본 — 오늘 서명 가능할까요?");
  await expect(confirm).toContainText("서연님, 확인했어요. 4시 전에 보낼게요.");
  // Nothing is sent before the explicit tap.
  expect((await mockState(page)).sent).toEqual([]);
  await confirm.getByRole("button", { name: "보내기", exact: true }).click();
  const receipt = page.getByRole("dialog", { name: "보냈어요" });
  await expect(receipt).toContainText(/내용 지문 [0-9a-f]{12}/);
  expect((await mockState(page)).sent).toEqual([
    {
      to: "seoyeon@hanbitpartners.example",
      subject: "Re: 계약서 수정본 — 오늘 서명 가능할까요?",
      body: "서연님, 확인했어요. 4시 전에 보낼게요.",
    },
  ]);
});

test("a new mail validates its recipient and sends from the primary account", async ({ page }) => {
  await phone(page, "/mail");
  await page.getByRole("button", { name: "새 메일 쓰기" }).click();
  const composer = page.getByRole("dialog", { name: "새 메일" });
  await composer.getByLabel("받는 사람").fill("not-an-address");
  await composer.getByLabel("제목").fill("안녕하세요");
  await composer.getByLabel("내용", { exact: true }).fill("본문");
  await expect(composer.getByRole("button", { name: "보내기 검토" })).toBeDisabled();
  await composer.getByLabel("받는 사람").fill("haeun@hanbit.example");
  await composer.getByRole("button", { name: "보내기 검토" }).click();
  const confirm = page.getByRole("dialog", { name: "보내기 전에 확인" });
  await expect(confirm).toContainText("jisu.shin@gmail.example");
  await confirm.getByRole("button", { name: "보내기", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "보냈어요" })).toBeVisible();
  expect((await mockState(page)).sent).toEqual([
    { to: "haeun@hanbit.example", subject: "안녕하세요", body: "본문" },
  ]);
});

test("Done works on any mail by its email id, and the server keeps it out of every list", async ({
  page,
}) => {
  // 이하은's mail is not on the firewall board (no attention id on the client).
  await phone(page, "/mail/email-haeun-1");
  await page
    .getByRole("navigation", { name: "메일 동작" })
    .getByRole("button", { name: "처리 완료" })
    .click();
  await expect(page).toHaveURL(/\/mail$/);
  await expect(row(page, /디자인 시스템 v2 리뷰 자료/)).toHaveCount(0);
  expect((await mockState(page)).dismissed).toEqual([]);
  await page.clock.runFor(5_200);
  await expect.poll(async () => (await mockState(page)).dismissed).toEqual(["att-email-haeun-1"]);
  // Past the optimistic local hide, the row stays out: the list asks hideHandled=1.
  await page.clock.runFor(61 * 60_000);
  await page.getByRole("tab", { name: /QUEUE/ }).click();
  await expect(row(page, /김도윤/)).toBeVisible();
  await expect(row(page, /디자인 시스템 v2 리뷰 자료/)).toHaveCount(0);
});

test("a new mail leaves from the account picked under 보내는 계정", async ({ page }) => {
  await phone(page, "/mail");
  await page.getByRole("button", { name: "새 메일 쓰기" }).click();
  const composer = page.getByRole("dialog", { name: "새 메일" });
  const from = composer.getByLabel("보내는 계정");
  // Connected accounts that can send; the one waiting for a reconnect is not offered.
  await expect(from.locator("option")).not.toContainText(["jisu@icloud.example"]);
  await from.selectOption("inbox-work");
  await composer.getByLabel("받는 사람").fill("haeun@hanbit.example");
  await composer.getByLabel("제목").fill("회의록");
  await composer.getByLabel("내용", { exact: true }).fill("공유드려요.");
  await composer.getByRole("button", { name: "보내기 검토" }).click();
  const confirm = page.getByRole("dialog", { name: "보내기 전에 확인" });
  await expect(confirm).toContainText("jisu@hanbit.example");
  await confirm.getByRole("button", { name: "보내기", exact: true }).click();
  const receipt = page.getByRole("dialog", { name: "보냈어요" });
  // MANUAL_SEND_RECEIPTS_ENABLED off: the hash is the device's, and the sheet says so.
  await expect(receipt).toContainText("확인한 내용으로 기기에서 계산한 해시");
  expect((await mockState(page)).sent).toEqual([
    { to: "haeun@hanbit.example", subject: "회의록", body: "공유드려요.", from: "inbox-work" },
  ]);
});

test("an account that cannot send from Klorn says so and sends nothing", async ({ page }) => {
  await phone(page, "/mail");
  await page.getByRole("button", { name: "새 메일 쓰기" }).click();
  const composer = page.getByRole("dialog", { name: "새 메일" });
  await composer.getByLabel("보내는 계정").selectOption("inbox-naver");
  await composer.getByLabel("받는 사람").fill("haeun@hanbit.example");
  await composer.getByLabel("제목").fill("회의록");
  await composer.getByLabel("내용", { exact: true }).fill("공유드려요.");
  await composer.getByRole("button", { name: "보내기 검토" }).click();
  const confirm = page.getByRole("dialog", { name: "보내기 전에 확인" });
  await confirm.getByRole("button", { name: "보내기", exact: true }).click();
  await expect(confirm.getByRole("alert")).toContainText("다른 계정을 골라 주세요");
  expect((await mockState(page)).sent).toEqual([]);
});

test("with server receipts on, the receipt is the server's ActionReceipt", async ({ page }) => {
  await phone(page, "/mail/email-att-push-1", "sendReceipts");
  await page.getByRole("button", { name: "고쳐 쓰기" }).click();
  await page
    .getByRole("dialog", { name: "답장" })
    .getByRole("button", { name: "보내기 검토" })
    .click();
  await page
    .getByRole("dialog", { name: "보내기 전에 확인" })
    .getByRole("button", { name: "보내기", exact: true })
    .click();
  const receipt = page.getByRole("dialog", { name: "보냈어요" });
  await expect(receipt).toContainText("보내기 전에 Klorn 서버가 기록한 해시");
  await expect(receipt).toContainText("영수증 번호 rcpt-mock-1");
  await expect(receipt).toContainText("내용 지문 5e7c0a3f9b21");
});

test("search goes to the server and narrows the list", async ({ page }) => {
  await phone(page, "/mail");
  await page.getByRole("searchbox").fill("포트폴리오");
  await expect(row(page, /김도윤/)).toBeVisible();
  await expect(row(page, /박서연/)).toHaveCount(0);
  await page.getByRole("button", { name: "검색어 지우기" }).click();
  await expect(row(page, /박서연/)).toBeVisible();
});

test("the account filter scopes the list to one connected account", async ({ page }) => {
  await phone(page, "/mail");
  await page.getByRole("button", { name: /계정 선택/ }).click();
  await page.getByRole("button", { name: /jisu@naver\.example/ }).click();
  await expect(row(page, /모아페이/)).toBeVisible();
  await expect(row(page, /박서연/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /계정 선택: jisu@naver\.example/ })).toBeVisible();
});

test("lane tabs filter, SILENT is reachable, and the list pages on scroll", async ({ page }) => {
  await phone(page, "/mail");
  await page.getByRole("tab", { name: /SILENT/ }).click();
  await expect(page).toHaveURL(/lane=SILENT/);
  await expect(row(page, /옷장마켓/)).toBeVisible();
  await page.getByRole("tab", { name: /전체/ }).click();
  await expect(row(page, /옷장마켓/)).toHaveCount(0);
  // 45 mock rows, 20 per page: scrolling to the end loads the rest.
  const scroller = page.locator(".mail-scroll");
  const booked = page.getByRole("link", { name: /예약이 확정되었습니다/ });
  // Scroll to the end until every page has arrived (each scroll may fetch the next).
  await expect
    .poll(async () => {
      await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      return booked.count();
    })
    .toBe(7);
});

test("deep link /mail/:id opens the reader; prev / next walk the list", async ({ page }) => {
  await phone(page, "/mail/email-att-meet-1");
  await expect(page.getByRole("heading", { name: "Re: 투자 미팅 목요일 → 금요일?" })).toBeVisible();
  await page.getByRole("button", { name: "메일", exact: true }).click();
  await row(page, /Mark Chen/).click();
  await page.getByRole("button", { name: "다음 메일" }).click();
  await expect(page).toHaveURL(/\/mail\/email-att-info-1$/);
  await page.getByRole("button", { name: "이전 메일" }).click();
  await expect(page).toHaveURL(/\/mail\/email-att-meet-1$/);
});

test("links in the mail never navigate the app or its frame", async ({ page }) => {
  // The system-browser hand-off is window.open in a browser (@capacitor/browser on native).
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });
  await phone(page, "/mail/email-att-push-1");
  const frame = page.frameLocator("iframe[title='메일 내용']");
  await frame.getByRole("link", { name: "여기" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
    .toEqual(["https://docs.hanbitpartners.example/contract/v3"]);
  await expect(page).toHaveURL(/\/mail\/email-att-push-1(\?|$)/);
  // The frame itself never navigated away from the mail, and runs nothing.
  await expect(frame.getByText("박서연 드림")).toBeVisible();
  const sandbox = await page.locator("iframe[title='메일 내용']").getAttribute("sandbox");
  expect(sandbox).toBe("allow-same-origin");
  expect(await frame.locator("script").count()).toBe(0);
});

test("Subscriptions: bulk clean-up lists the rarely read senders before acting", async ({
  page,
}) => {
  await phone(page, "/mail");
  await page.getByRole("button", { name: "더 보기" }).first().click();
  await page.getByRole("button", { name: /구독 관리/ }).click();
  await expect(page).toHaveURL(/\/mail\/subscriptions$/);
  await page.getByRole("button", { name: "옷장마켓 구독취소" }).click();
  await expect(page.getByRole("status").filter({ hasText: "취소됨" })).toBeVisible();
  await page.getByRole("button", { name: /거의 안 읽는 11곳 한 번에 정리/ }).click();
  const confirm = page.getByRole("dialog", { name: "11곳 구독을 취소할까요?" });
  await expect(confirm.getByRole("listitem")).toHaveCount(11);
  await expect(confirm).toContainText("삭제하지 않아요");
  await confirm.getByRole("button", { name: "11곳 구독취소" }).click();
  await expect(page.getByText(/구독을 취소하고 메일을 목록에서 정리했어요/)).toBeVisible();
  expect((await mockState(page)).unsubscribed.length).toBeGreaterThanOrEqual(10);
});

test("with BULK_UNSUBSCRIBE_ENABLED off the Subscriptions entry is hidden", async ({ page }) => {
  await phone(page, "/mail", "flagsOff");
  await page.getByRole("button", { name: "더 보기" }).first().click();
  await expect(page.getByRole("button", { name: /여러 개 선택/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /구독 관리/ })).toHaveCount(0);
});

test("the reader replaces the tab bar on phones; the list keeps it", async ({ page }) => {
  await phone(page, "/mail");
  await expect(page.locator(".tabbar")).toBeVisible();
  await row(page, /박서연/).click();
  await expect(page.getByRole("navigation", { name: "메일 동작" })).toBeVisible();
  await expect(page.locator(".tabbar")).toBeHidden();
});
