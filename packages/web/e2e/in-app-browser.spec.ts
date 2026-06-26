import { expect, test } from "@playwright/test";

// A real Samsung WebView UA carrying the KakaoTalk in-app-browser token. This
// is the exact environment that produced `403: disallowed_useragent` on the
// Google consent screen, which the login banner is meant to pre-empt.
const KAKAOTALK_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 KAKAOTALK 10.4.5";

test.describe("In-app browser OAuth guard", () => {
  test.describe("inside a KakaoTalk WebView", () => {
    test.use({ userAgent: KAKAOTALK_UA });

    test("warns the user to reopen in a real browser", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByText("Open in your browser to sign in")).toBeVisible();
      // The detected app name is named so the message is unambiguous.
      await expect(page.getByText(/KakaoTalk's in-app browser/)).toBeVisible();
      await expect(page.getByText("403: disallowed_useragent")).toBeVisible();
      await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    });
  });

  test.describe("in a normal browser", () => {
    test("does not show the notice", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByText("Open in your browser to sign in")).toHaveCount(0);
    });
  });
});
