/**
 * Behaviour of Calendar, Assistant, Files, Accounts and Settings against the
 * mock API: nothing is written without an explicit confirmation, decisions
 * leave the list, feature-gated sources hide, and account deletion needs the
 * typed address.
 */
import { expect, test } from "@playwright/test";
import { openApp, settle } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("approving a send waits for the server, then the card leaves", async ({ page }) => {
  await openApp(page, "/assistant/approvals");
  await settle(page);
  await expect(page.getByRole("tab", { name: "승인 3" })).toBeVisible();
  await page.getByRole("button", { name: /^보내기: Re: 계약서 수정본/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "보냈어요" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "승인 2" })).toBeVisible();
  await expect(page.getByText("seoyeon@hanbitpartners.example")).toHaveCount(0);
});

test("rejecting asks first, with an optional reason", async ({ page }) => {
  await openApp(page, "/assistant/approvals");
  await settle(page);
  await page.getByRole("button", { name: "거절" }).first().click();
  const sheet = page.getByRole("dialog", { name: "거절할까요?" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("이유 (선택)").fill("통화 후 직접 답장");
  await sheet.getByRole("button", { name: "거절하기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "거절했어요" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "승인 2" })).toBeVisible();
});

test("a new event is written only after the confirm step", async ({ page }) => {
  await openApp(page, "/calendar");
  await settle(page);
  await page.getByRole("button", { name: "새 일정" }).click();
  const form = page.getByRole("dialog", { name: "새 일정" });
  await form.getByRole("button", { name: "확인하기" }).click();
  await expect(form.getByRole("alert")).toHaveText("일정 제목을 적어 주세요.");
  await form.getByLabel("제목").fill("치과 예약");
  await form.getByRole("button", { name: "확인하기" }).click();
  const confirm = page.getByRole("dialog", { name: "이렇게 만들까요?" });
  await expect(confirm.getByText("치과 예약")).toBeVisible();
  await expect(confirm.getByText("확인하기 전에는 아무것도 저장되지 않아요.")).toBeVisible();
  // Not on the calendar before the confirmation.
  await expect(page.getByRole("link", { name: "치과 예약" })).toHaveCount(0);
  await confirm.getByRole("button", { name: "일정 만들기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "캘린더에 추가했어요" })).toBeVisible();
  await expect(page.getByRole("link", { name: "치과 예약" })).toBeVisible();
});

test("team free time drafts an invite that still needs confirming", async ({ page }) => {
  await openApp(page, "/calendar");
  await settle(page);
  await page.getByRole("button", { name: "팀 빈 시간" }).click();
  await page.getByRole("radio", { name: /10월 22일/ }).check();
  await page.getByRole("button", { name: "초대 초안 만들기" }).click();
  const confirm = page.getByRole("dialog", { name: "이렇게 만들까요?" });
  await expect(confirm.getByText("디자인팀 회의")).toBeVisible();
  await expect(confirm.getByText("3명에게 초대가 가요")).toBeVisible();
  await expect(confirm.getByRole("button", { name: "만들고 초대 보내기" })).toBeVisible();
});

test("a conflict hands the question to the assistant without sending it", async ({ page }) => {
  await openApp(page, "/calendar");
  await settle(page);
  await page.getByRole("button", { name: /하은 님 1:1 일정과 겹쳐요/ }).click();
  await expect(page).toHaveURL(/\/assistant\/chat$/);
  await expect(page.getByLabel("메시지")).toHaveValue(/투자사 미팅 · Mark Chen.*겹쳐요/);
  await expect(page.locator(".chat-bubble")).toHaveCount(1);
});

test("the week strip moves a week at a time", async ({ page }) => {
  await openApp(page, "/calendar");
  await settle(page);
  await page.getByRole("button", { name: "다음 주" }).dispatchEvent("click");
  await expect(page.getByRole("button", { name: /10월 23일 금요일/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "오늘", exact: true }).click();
  await expect(page.getByRole("heading", { name: /오늘 · 금요일/ })).toBeVisible();
});

test("chat sends a turn and resumes the latest conversation", async ({ page }) => {
  await openApp(page, "/assistant/chat");
  await settle(page);
  await expect(page.getByText("디자인팀 회의")).toBeVisible();
  await page.getByLabel("메시지").fill("답장 안 한 급한 메일 있어?");
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await expect(page.getByText("박서연 님의 계약서 회신 한 통")).toBeVisible();
});

test("files: sources filter, attachment search, detail opens the mail", async ({ page }) => {
  await openApp(page, "/files");
  await settle(page);
  await page.getByRole("button", { name: "메일 첨부", exact: true }).click();
  await expect(page.getByRole("link", { name: "2026 Q4 예산.xlsx" })).toHaveCount(0);
  await page.getByLabel("파일 검색").fill("해지");
  await expect(page.getByRole("link", { name: /\.pdf$|\.docx$/ })).toHaveCount(1);
  await page.getByRole("link", { name: "계약서_v3_한빛파트너스.pdf" }).click();
  await expect(page.getByText("3조 지급 일정 2주 단축").first()).toBeVisible();
  await page.getByRole("button", { name: "메일에서 보기" }).click();
  await expect(page).toHaveURL(/\/mail\/email-contract$/);
});

test("features off: unavailable sources and team time are hidden", async ({ page }) => {
  await openApp(page, "/files", { scenario: "featuresOff" });
  await settle(page);
  await expect(page.getByRole("button", { name: "Klorn 드라이브" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Google Drive" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "메일 첨부", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Klorn 드라이브에 올리기" })).toHaveCount(0);
  await page.goto("/calendar");
  await settle(page);
  await expect(page.getByRole("button", { name: "팀 빈 시간" })).toHaveCount(0);
});

test("disconnecting an account needs a second tap", async ({ page }) => {
  await openApp(page, "/accounts");
  await settle(page);
  await page.getByRole("button", { name: /^네이버/ }).click();
  const sheet = page.getByRole("dialog", { name: "네이버" });
  await sheet.getByRole("button", { name: "연결 끊기" }).click();
  await expect(sheet.getByRole("alert")).toContainText("연결을 끊을까요?");
  await sheet.getByRole("button", { name: "연결 끊기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "연결을 끊었어요" })).toBeVisible();
});

test("adding an IMAP account validates before connecting", async ({ page }) => {
  await openApp(page, "/accounts");
  await settle(page);
  await page.getByRole("button", { name: /계정 추가/ }).click();
  await page
    .getByRole("dialog", { name: "계정 추가" })
    .getByRole("button", { name: /네이버/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "네이버" });
  await sheet.getByRole("button", { name: "연결하기" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("올바른 이메일 주소를 입력해 주세요.");
  await sheet.getByLabel("이메일 주소").fill("jisu2@naver.example");
  await sheet.getByLabel("앱 비밀번호").fill("abcd");
  await sheet.getByRole("button", { name: "연결하기" }).click();
  await expect(sheet.getByRole("alert")).toContainText("앱 전용 비밀번호를 확인해 주세요");
});

test("account deletion needs the typed address, then lands on Welcome", async ({ page }) => {
  await openApp(page, "/settings/delete-account");
  await settle(page);
  const button = page.getByRole("button", { name: "계정 영구 삭제" });
  await expect(button).toBeDisabled();
  await page.getByLabel(/확인하려면/).fill("someone@else.example");
  await expect(button).toBeDisabled();
  await page.getByLabel(/확인하려면/).fill("JISU@hanbit.example");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    page.getByRole("status").filter({ hasText: "계정과 데이터를 삭제했어요" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Google로 계속하기" })).toBeVisible();
});

test("settings: plan shows without any purchase link in a browser", async ({ page }) => {
  await openApp(page, "/settings/plans");
  await settle(page);
  await expect(page.getByRole("heading", { name: "Pro", level: 2, exact: true })).toBeVisible();
  await expect(page.getByText("앱에서 구독하는 기능은 아직 준비 중이에요.")).toBeVisible();
  await expect(page.getByRole("link", { name: /checkout|stripe|paddle/i })).toHaveCount(0);
});

test("Plans states the subscription terms Apple 3.1.2 asks for, next to Restore", async ({
  page,
}) => {
  await openApp(page, "/settings/plans?iap=ios");
  await settle(page);
  const offer = page.getByRole("region", { name: "Klorn Pro" });
  await expect(offer).toContainText("자동 갱신 구독");
  await expect(offer).toContainText("1개월");
  await expect(offer).toContainText("월 ₩14,000");
  await expect(page.getByText(/기간이 끝나기 24시간 전까지 해지하지 않으면/)).toContainText(
    "App Store 계정",
  );
  await expect(page.getByText(/설정 › \[내 이름\] › 구독/)).toBeVisible();
  await expect(page.getByRole("button", { name: "구매 복원" })).toBeVisible();
  const legal = page.getByRole("navigation", { name: "약관과 개인정보" });
  await expect(legal.getByRole("link", { name: "이용약관" })).toHaveAttribute(
    "href",
    "https://klorn.ai/terms/",
  );
  await expect(legal.getByRole("link", { name: "개인정보 처리방침" })).toHaveAttribute(
    "href",
    "https://klorn.ai/privacy/",
  );
  await expect(page.getByRole("link", { name: /checkout|stripe|paddle/i })).toHaveCount(0);
});

test("Plans on Google Play names Play's cancel path", async ({ page }) => {
  await openApp(page, "/settings/plans?iap=android");
  await settle(page);
  await expect(page.getByText(/Google Play 계정/)).toBeVisible();
  await expect(page.getByText(/결제 및 정기 결제 › 정기 결제/)).toBeVisible();
});

test("the expanded assistant side sheet closes with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 1024 });
  await openApp(page, "/files");
  await settle(page);
  await page.getByRole("button", { name: "도우미에게 묻기" }).click();
  await expect(page.getByRole("dialog", { name: "도우미" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "도우미" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/files(\?|$)/);
});

test("flip cover: Later snoozes the item for an hour", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 400 });
  await openApp(page, "/today");
  await settle(page);
  await expect(page.getByText("박서연 님이 계약서 회신을 기다려요")).toBeVisible();
  await page.getByRole("button", { name: "나중에" }).click();
  await expect(page.locator(".cover__hint")).toContainText("1시간 뒤에 다시 알려 드릴게요");
  await expect(page.getByText("박서연 님이 계약서 회신을 기다려요")).toHaveCount(0);
});

test("push priming asks once and explains that only PUSH rings", async ({ page }) => {
  await openApp(page, "/today?priming=1");
  await expect(page.getByRole("dialog", { name: "꼭 필요할 때만 울려요" })).toBeVisible();
  await expect(page.getByText(/PUSH 메일과 일정 조율 MEETING 메일만/)).toBeVisible();
  await page.getByRole("button", { name: "나중에" }).click();
  await expect(page.getByRole("dialog", { name: "꼭 필요할 때만 울려요" })).toHaveCount(0);
});
