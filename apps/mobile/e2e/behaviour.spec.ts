/** Behaviour across re-layouts: selection survives, navigation chrome follows the size class. */
import { expect, test } from "@playwright/test";
import { openApp, settle } from "./helpers";

test("selected mail survives rotation / unfolding / window resize", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/mail/email-att-meet-1");
  await settle(page);
  const subject = page.getByRole("heading", { name: "Re: 투자 미팅 목요일 → 금요일?" });
  await expect(subject).toBeVisible();
  await expect(page.locator(".shell")).toHaveAttribute("data-nav", "tabs");

  for (const size of [
    { width: 884, height: 1104, nav: "rail" },
    { width: 1366, height: 1024, nav: "sidebar" },
    { width: 700, height: 900, nav: "rail" },
    { width: 412, height: 915, nav: "tabs" },
  ]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await expect(page.locator(".shell")).toHaveAttribute("data-nav", size.nav);
    await expect(subject).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/mail/email-att-meet-1");
  }
});

test("tab bar navigates with real links and keeps deep links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/today");
  await settle(page);
  await page
    .getByRole("navigation", { name: "주요 메뉴" })
    .getByRole("link", { name: "캘린더" })
    .click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole("heading", { name: "캘린더", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/today(\?|$)/);
});

test("a lane cell opens Mail filtered to that lane", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/today");
  await settle(page);
  await page.getByRole("link", { name: "QUEUE 14통" }).click();
  await expect(page).toHaveURL(/\/mail\?lane=QUEUE$/);
});

test("email sign-up from Welcome creates the account and lands on Today", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/today", { scenario: "signedOut" });
  await page.getByRole("button", { name: "이메일로 계속하기" }).click();
  await page.getByRole("button", { name: "계정이 없나요? 이메일로 가입하기" }).click();
  await expect(page.getByRole("heading", { name: "이메일로 가입", level: 1 })).toBeVisible();
  await page.getByLabel("이름 (선택)").fill("하은");
  await page.getByLabel("이메일").fill("jisu@hanbit.example");
  await page.getByLabel("비밀번호").fill("short");
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect(page.getByRole("alert")).toHaveText("비밀번호는 8자 이상이어야 해요.");
  await page.getByLabel("비밀번호").fill("correct-horse");
  await page.getByRole("button", { name: "가입하기" }).click();
  // The server's 409: the address already has an account.
  await expect(page.getByRole("alert")).toHaveText("이미 가입된 주소예요. 로그인해 주세요.");
  await page.getByLabel("이메일").fill("haeun@new.example");
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect(page.getByRole("heading", { name: "오늘", level: 1 })).toBeVisible();
});

test("while sign-up is invite-only, Welcome says so and shows the server's refusal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/today?signup=closed", { scenario: "signedOut" });
  await page.getByRole("button", { name: "이메일로 계속하기" }).click();
  await page.getByRole("button", { name: "계정이 없나요? 이메일로 가입하기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "초대받은 분만" })).toBeVisible();
  await page.getByLabel("이메일").fill("someone@new.example");
  await page.getByLabel("비밀번호").fill("correct-horse");
  await page.getByRole("button", { name: "가입하기" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("이 주소로는 아직 가입할 수 없어요");
  await expect(alert.getByRole("link", { name: "초대 요청하기" })).toHaveAttribute(
    "href",
    "https://app.klorn.ai/early-access",
  );
  // An approved address registers.
  await page.getByLabel("이메일").fill("haeun@approved.example");
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect(page.getByRole("heading", { name: "오늘", level: 1 })).toBeVisible();
});

test("email sign-in from Welcome lands on Today", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/today", { scenario: "signedOut" });
  await page.getByRole("button", { name: "이메일로 계속하기" }).click();
  await page.getByLabel("이메일").fill("jisu@hanbit.example");
  await page.getByLabel("비밀번호").fill("short");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("alert")).toHaveText("이메일 또는 비밀번호가 맞지 않아요.");
  await page.getByLabel("비밀번호").fill("correct-horse");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("heading", { name: "오늘", level: 1 })).toBeVisible();
});
