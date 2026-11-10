/**
 * Mail — screenshots of every new screen and state at the phone, Fold (flat,
 * hinge, tabletop) and iPad-landscape sizes, light and dark, against the
 * Mail / Reader / LaneSheet / Subscriptions / FoldOpen / FoldTabletop /
 * TabletLandscape artboards. Screenshots go to $KLORN_SHOTS_DIR/mail/.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  emulateHinge,
  type Hinge,
  openApp,
  SHOTS_DIR,
  segmentCount,
  settle,
  snap,
  untilPersisted,
} from "./helpers";
import { holdSwipe, swipe } from "./mail-helpers";

const DIR = `${SHOTS_DIR}/mail`;

interface Device {
  name: string;
  width: number;
  height: number;
  insets?: string;
  hinge?: Hinge;
}

const DEVICES: Device[] = [
  { name: "iphone-390x844", width: 390, height: 844, insets: "47,0,34,0" },
  { name: "android-412x915", width: 412, height: 915, insets: "24,0,16,0" },
  { name: "fold-open-884x1104", width: 884, height: 1104 },
  {
    name: "fold-hinge-884x1104",
    width: 884,
    height: 1104,
    hinge: { orientation: "vertical", offset: 442, maskLength: 0 },
  },
  {
    name: "fold-tabletop-884x1104",
    width: 884,
    height: 1104,
    hinge: { orientation: "horizontal", offset: 540, maskLength: 24 },
  },
  { name: "ipad-landscape-1366x1024", width: 1366, height: 1024, insets: "24,0,20,0" },
];

async function open(
  page: Page,
  device: Device,
  path: string,
  theme: "light" | "dark",
  scenario = "default",
) {
  await page.setViewportSize({ width: device.width, height: device.height });
  await openApp(page, path, { theme, insets: device.insets, scenario });
  if (device.hinge) {
    expect(await emulateHinge(page, device.hinge)).toBe(true);
    await expect.poll(() => segmentCount(page)).toBe(2);
  }
  await settle(page);
}

/** Settled data, finished transitions — then the picture (`loading`: the skeleton). */
async function shot(page: Page, name: string, options: { loading?: boolean } = {}) {
  await snap(page, `${DIR}/${name}.png`, options);
}

for (const theme of ["light", "dark"] as const) {
  for (const device of DEVICES) {
    test(`mail list · ${device.name} · ${theme}`, async ({ page }) => {
      await open(page, device, "/mail", theme);
      await expect(page.getByRole("heading", { name: /메일/, level: 1 })).toBeVisible();
      await expect(page.getByText("계약서 수정본 — 오늘 서명 가능할까요?").first()).toBeVisible();
      await shot(page, `list-${device.name}-${theme}`);
    });

    test(`mail reader · ${device.name} · ${theme}`, async ({ page }) => {
      await open(page, device, "/mail/email-att-push-1", theme);
      await expect(
        page.getByRole("heading", { name: "계약서 수정본 — 오늘 서명 가능할까요?", level: 1 }),
      ).toBeVisible();
      await expect(page.getByText("지금 알려드린 이유")).toBeVisible();
      await shot(page, `reader-${device.name}-${theme}`);
    });

    test(`lane sheet (left swipe) · ${device.name} · ${theme}`, async ({ page }) => {
      await open(page, device, "/mail", theme);
      await swipe(page, page.getByRole("link", { name: /한끼배달/ }).first(), -160);
      const sheet = page.getByRole("dialog", { name: "레인 옮기기" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("radio", { name: /SILENT/ })).toBeChecked();
      await expect(sheet.getByRole("button", { name: "SILENT로 옮기기" })).toBeEnabled();
      await shot(page, `lanesheet-${device.name}-${theme}`);
    });

    test(`subscriptions · ${device.name} · ${theme}`, async ({ page }) => {
      await open(page, device, "/mail/subscriptions", theme);
      await expect(page.getByRole("heading", { name: "구독 관리", level: 1 })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "거의 안 읽는 12곳 한 번에 정리" }),
      ).toBeVisible();
      await shot(page, `subscriptions-${device.name}-${theme}`);
    });
  }
}

/** Phone-size states and flows (390×844, both themes). */
const PHONE: Device = { name: "iphone-390x844", width: 390, height: 844, insets: "47,0,34,0" };

for (const theme of ["light", "dark"] as const) {
  test(`mid-swipe reveal · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    const release = await holdSwipe(page, page.getByRole("link", { name: /한끼배달/ }).first(), 96);
    await shot(page, `swipe-done-reveal-390x844-${theme}`);
    await release();
  });

  test(`done + undo snackbar · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    await swipe(page, page.getByRole("link", { name: /한끼배달/ }).first(), 160);
    await expect(page.getByRole("status").filter({ hasText: "처리 완료" })).toBeVisible();
    await shot(page, `done-snackbar-390x844-${theme}`);
  });

  test(`multi-select · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    const row = page.getByRole("link", { name: /Mark Chen/ }).first();
    const box = await row.boundingBox();
    if (!box) throw new Error("row");
    await page.mouse.move(box.x + 120, box.y + box.height / 2);
    await page.mouse.down();
    // The gesture itself: a long press is a held pointer (longer than the threshold).
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page
      .getByRole("link", { name: /박서연/ })
      .first()
      .click();
    await expect(page.getByText("2개 선택됨")).toBeVisible();
    await shot(page, `multiselect-390x844-${theme}`);
  });

  test(`account sheet · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    await page.getByRole("button", { name: /계정 선택/ }).click();
    await expect(page.getByRole("dialog", { name: "어느 계정의 메일을 볼까요" })).toBeVisible();
    await shot(page, `accounts-sheet-390x844-${theme}`);
  });

  test(`mail menu · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    await page.getByRole("button", { name: "더 보기" }).first().click();
    await expect(page.getByRole("button", { name: /구독 관리/ })).toBeVisible();
    await shot(page, `menu-sheet-390x844-${theme}`);
  });

  test(`row actions sheet · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    await page.getByRole("button", { name: /포트폴리오 피드백 부탁드려요 동작/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "메일 동작" })).toBeVisible();
    await shot(page, `row-actions-390x844-${theme}`);
  });

  test(`later sheet · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail/email-att-meet-1", theme);
    await page.getByRole("button", { name: "나중에" }).click();
    await expect(page.getByRole("dialog", { name: "언제 다시 보여드릴까요" })).toBeVisible();
    await shot(page, `later-sheet-390x844-${theme}`);
  });

  test(`reader draft card · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail/email-att-push-1", theme);
    await page.getByRole("heading", { name: "내 말투로 쓴 답장" }).scrollIntoViewIfNeeded();
    await shot(page, `reader-draft-390x844-${theme}`);
  });

  test(`reader designed html + images blocked · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail/email-att-info-1", theme);
    await expect(page.getByRole("button", { name: "이미지 보기" })).toBeVisible();
    await shot(page, `reader-html-images-blocked-390x844-${theme}`);
    await page.getByRole("button", { name: "이미지 보기" }).click();
    await shot(page, `reader-html-images-shown-390x844-${theme}`);
  });

  test(`reader plain text (English) · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail/email-att-meet-1", theme);
    await expect(page.getByText(/Something came up/)).toBeVisible();
    await shot(page, `reader-plain-390x844-${theme}`);
  });

  test(`reply composer + confirm + receipt · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail/email-att-push-1", theme);
    await page.getByRole("button", { name: "고쳐 쓰기" }).click();
    await expect(page.getByRole("dialog", { name: "답장" })).toBeVisible();
    await shot(page, `composer-reply-390x844-${theme}`);
    await page
      .getByRole("dialog", { name: "답장" })
      .getByRole("button", { name: "보내기 검토" })
      .click();
    await expect(page.getByRole("dialog", { name: "보내기 전에 확인" })).toBeVisible();
    await shot(page, `confirm-send-390x844-${theme}`);
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "보냈어요" })).toBeVisible();
    await shot(page, `receipt-390x844-${theme}`);
  });

  test(`new mail composer · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    await page.getByRole("button", { name: "새 메일 쓰기" }).click();
    await page.getByLabel("받는 사람").fill("haeun@hanbit.example");
    await page.getByLabel("제목").fill("리뷰 일정");
    await page
      .getByLabel("내용", { exact: true })
      .fill("하은님, 금요일 리뷰 전에 자료 확인해 둘게요.");
    await shot(page, `composer-new-390x844-${theme}`);
  });

  test(`search results · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    await page.getByRole("searchbox").fill("계약");
    await expect(page.getByText("계약서 수정본 — 오늘 서명 가능할까요?")).toBeVisible();
    await expect(page.getByText("Mark Chen")).toHaveCount(0);
    await shot(page, `search-390x844-${theme}`);
  });

  test(`subscriptions bulk confirm · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail/subscriptions", theme);
    await page.getByRole("button", { name: "거의 안 읽는 12곳 한 번에 정리" }).click();
    await expect(page.getByRole("dialog", { name: "12곳 구독을 취소할까요?" })).toBeVisible();
    await shot(page, `subscriptions-confirm-390x844-${theme}`);
  });

  for (const scenario of ["loading", "empty", "error", "noAccounts"] as const) {
    test(`list state ${scenario} · ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
      await openApp(page, "/mail", { theme, insets: PHONE.insets, scenario });
      await shot(page, `state-${scenario}-390x844-${theme}`, { loading: scenario === "loading" });
    });
  }

  test(`lane empty (PUSH clear) · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await openApp(page, "/mail?lane=PUSH", { theme, insets: PHONE.insets, scenario: "empty" });
    await settle(page);
    await expect(page.getByText("PUSH가 비었어요")).toBeVisible();
    await shot(page, `state-push-empty-390x844-${theme}`);
  });

  test(`reader loading + error · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await openApp(page, "/mail/email-att-push-1", {
      theme,
      insets: PHONE.insets,
      scenario: "loading",
    });
    await shot(page, `state-reader-loading-390x844-${theme}`, { loading: true });
    await openApp(page, "/mail/email-att-push-1", {
      theme,
      insets: PHONE.insets,
      scenario: "error",
    });
    await settle(page);
    await shot(page, `state-reader-error-390x844-${theme}`);
  });

  test(`offline with cached mail · ${theme}`, async ({ page }) => {
    await open(page, PHONE, "/mail", theme);
    await untilPersisted(page, '"mail","feed"');
    await page.goto("/mail?scenario=offline");
    // The Mail chunk is local in the app; here it comes from the preview server.
    await expect(page.getByRole("heading", { name: "메일", level: 1 })).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole("status").filter({ hasText: "오프라인이에요" })).toBeVisible();
    await expect(page.getByText("계약서 수정본 — 오늘 서명 가능할까요?")).toBeVisible();
    await shot(page, `state-offline-cached-390x844-${theme}`);
  });

  test(`offline without cache · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height });
    await openApp(page, "/mail", { theme, insets: PHONE.insets, scenario: "offline" });
    await expect(page.getByRole("alert").filter({ hasText: "오프라인이에요" })).toBeVisible();
    await shot(page, `state-offline-empty-390x844-${theme}`);
  });
}
