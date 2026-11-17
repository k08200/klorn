import { expect, type Page, test } from "@playwright/test";

/**
 * Device matrix for the app shell's tiers (mobile redesign PR1, MB4):
 *   tiny   < 360px  bottom tabs, icon-only labels, 56px bar
 *   phone  360–599  bottom tabs + header bell and account avatar
 *   rail   600–839  navigation rail; the mail split starts here
 *   wide   ≥ 840px  sidebar (220px up to 1023px, 260px from 1024px); a phone
 *                    on its side (< 500px tall) keeps the rail up to 1023px
 * The shell is reached signed in with every API call mocked, the same way
 * navigation.spec.ts does it.
 */

type Tier = "tiny" | "phone" | "rail" | "wide";

const DEVICES: ReadonlyArray<{ name: string; width: number; height: number; tier: Tier }> = [
  { name: "iPad 1/3 split", width: 320, height: 1000, tier: "tiny" },
  { name: "Fold cover", width: 344, height: 882, tier: "tiny" },
  { name: "Android compact", width: 360, height: 780, tier: "phone" },
  { name: "iPhone SE", width: 375, height: 667, tier: "phone" },
  { name: "iPhone 15", width: 393, height: 852, tier: "phone" },
  { name: "Pixel XL", width: 412, height: 915, tier: "phone" },
  { name: "iPhone Pro Max", width: 440, height: 956, tier: "phone" },
  { name: "Fold open", width: 690, height: 840, tier: "rail" },
  { name: "iPad mini", width: 744, height: 1133, tier: "rail" },
  // A phone on its side keeps the compact rail up to 1024px, not the sidebar.
  { name: "iPhone Pro Max landscape", width: 932, height: 430, tier: "rail" },
  { name: "Small laptop window", width: 840, height: 1000, tier: "wide" },
  { name: "iPad Air landscape", width: 1180, height: 820, tier: "wide" },
  { name: "iPad Pro landscape", width: 1366, height: 1024, tier: "wide" },
];

const SIGNED_IN_USER = {
  id: "user-1",
  email: "first-user@example.com",
  name: "First User",
  plan: "FREE",
  role: "USER",
  googleConnected: false,
  // A mail source keeps AuthGuard from routing to /onboarding.
  hasAnyMailSource: true,
  unifiedHome: true,
  mailV2: true,
};

// One unread notification, so the header bell carries a count.
const API_RESPONSES: Record<string, () => unknown> = {
  "/api/auth/me": () => ({ user: SIGNED_IN_USER }),
  "/api/notifications": () => ({
    notifications: [
      {
        id: "n-1",
        type: "email",
        title: "Investor follow-up",
        message: "Reply requested",
        isRead: false,
        createdAt: new Date().toISOString(),
      },
    ],
  }),
  "/api/notifications/alert-endpoints": () => ({ endpoints: [] }),
  "/api/calendar": () => ({ events: [] }),
  "/api/email": () => ({ emails: [], threads: [], source: "demo", total: 0, unread: 0 }),
  "/api/chat/conversations": () => ({ conversations: [] }),
  "/api/chat/pending-actions": () => ({ actions: [] }),
  "/api/commitments": () => ({ commitments: [] }),
};

async function mockSignedIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("klorn-token", "test-token");
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = API_RESPONSES[path]?.() ?? {};
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function openShell(page: Page, path = "/calendar") {
  await mockSignedIn(page);
  await page.goto(path);
  await expect(page.locator("#main")).toBeVisible();
}

function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - window.innerWidth;
  });
}

for (const device of DEVICES) {
  test.describe(`${device.name} ${device.width}×${device.height} (${device.tier})`, () => {
    test.use({ viewport: { width: device.width, height: device.height } });

    test("shows the right navigation tier without horizontal overflow", async ({ page }) => {
      await openShell(page);

      const tabs = page.getByTestId("bottom-tabs");
      const rail = page.getByTestId("nav-rail");
      const sidebar = page.getByTestId("sidebar");
      const phoneTier = device.tier === "tiny" || device.tier === "phone";

      if (phoneTier) {
        await expect(tabs).toBeVisible();
        await expect(rail).toBeHidden();
        await expect(sidebar).toBeHidden();
      } else if (device.tier === "rail") {
        await expect(tabs).toBeHidden();
        await expect(rail).toBeVisible();
        await expect(sidebar).toBeHidden();
      } else {
        await expect(tabs).toBeHidden();
        await expect(rail).toBeHidden();
        await expect(sidebar).toBeVisible();
      }

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    if (device.tier === "tiny" || device.tier === "phone") {
      test("phone header carries the bell with a count and the account avatar", async ({
        page,
      }) => {
        await openShell(page);
        const header = page.getByTestId("phone-header");
        const bell = header.getByRole("button", { name: /^Notifications/ });
        await expect(bell).toBeVisible();
        await expect(bell).toHaveAccessibleName(/1/);
        const avatar = header.getByRole("button", { name: "Account and settings" });
        await expect(avatar).toBeVisible();

        for (const target of [bell, avatar]) {
          const box = await target.boundingBox();
          expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        }

        // The avatar moved to the header: the tab bar holds only destinations.
        const tabs = page.getByTestId("bottom-tabs");
        await expect(tabs.getByRole("button")).toHaveCount(0);
        await expect(tabs.getByRole("link")).toHaveCount(4);

        await bell.click();
        await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
        await expect(page.getByText("Investor follow-up")).toBeVisible();
      });

      test("header avatar opens the account sheet", async ({ page }) => {
        await openShell(page);
        await page
          .getByTestId("phone-header")
          .getByRole("button", { name: "Account and settings" })
          .click();
        await expect(page.getByRole("dialog", { name: "Account and settings" })).toBeVisible();
      });

      test("tab labels follow the tier and the toast region clears the tab bar", async ({
        page,
      }) => {
        await openShell(page);
        const tabs = page.getByTestId("bottom-tabs");
        const firstLink = tabs.getByRole("link").first();
        await expect(firstLink).toHaveAccessibleName("Today");

        const labelWidth = await tabs
          .locator("[data-tab-label]")
          .first()
          .evaluate((el) => el.getBoundingClientRect().width);
        if (device.tier === "tiny") {
          expect(labelWidth).toBeLessThanOrEqual(1);
          const tab = await firstLink.boundingBox();
          expect(Math.round(tab?.height ?? 0)).toBe(56);
        } else {
          expect(labelWidth).toBeGreaterThan(1);
        }

        const barBox = await tabs.boundingBox();
        const toastBox = await page.getByTestId("toast-region").boundingBox();
        expect(barBox).not.toBeNull();
        expect(toastBox).not.toBeNull();
        if (barBox && toastBox) {
          expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(barBox.y);
        }
      });

      test("type roles use the mobile scale", async ({ page }) => {
        await openShell(page);
        const sizes = await page.evaluate(() => {
          const probe = (cls: string) => {
            const el = document.createElement("span");
            el.className = cls;
            el.textContent = "x";
            document.body.appendChild(el);
            const px = Number.parseFloat(getComputedStyle(el).fontSize);
            el.remove();
            return px;
          };
          return {
            page: probe("text-role-page"),
            title: probe("text-role-title"),
            body: probe("text-role-body"),
            meta: probe("text-role-meta"),
          };
        });
        expect(sizes.page).toBe(device.tier === "tiny" ? 20 : 22);
        expect(sizes.title).toBe(19);
        expect(sizes.body).toBe(15);
        expect(sizes.meta).toBe(12.5);
      });
    } else {
      test("no phone header and desktop type scale", async ({ page }) => {
        await openShell(page);
        await expect(page.getByTestId("phone-header")).toBeHidden();
        const pageSize = await page.evaluate(() => {
          const el = document.createElement("span");
          el.className = "text-role-page";
          el.textContent = "x";
          document.body.appendChild(el);
          const px = Number.parseFloat(getComputedStyle(el).fontSize);
          el.remove();
          return px;
        });
        expect(pageSize).toBe(34);
      });

      test("mail opens as a split view without overflow", async ({ page }) => {
        await openShell(page, "/email");
        await expect(page.locator(".mail-split")).toBeVisible();
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      });
    }
  });
}

test.describe("Type follows the user's font size", () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test("role sizes are rem, so a larger root font scales them", async ({ page }) => {
    await openShell(page);
    const pageSize = await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
      const el = document.createElement("span");
      el.className = "text-role-page";
      el.textContent = "x";
      document.body.appendChild(el);
      const px = Number.parseFloat(getComputedStyle(el).fontSize);
      el.remove();
      return px;
    });
    expect(pageSize).toBe(42.5);
  });
});
