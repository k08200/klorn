import { expect, type Page, test } from "@playwright/test";
import en from "../src/lib/locales/en";

/**
 * Step D5c (docs/providers/unified-platform-plan.md) — /files › Google Drive.
 *
 *   - Dark: while GET /api/drive/google/accounts answers 404 (the server's
 *     DRIVE_ENABLED or GOOGLE_DRIVE_ENABLED off) nothing of it renders.
 *   - The Picker's script (https://apis.google.com/js/api.js) is not requested,
 *     nor on the page, before "Add from Google Drive" is clicked.
 *   - In a build with NEXT_PUBLIC_GOOGLE_DRIVE_PICKER=on: the click fetches the
 *     session, opens the Picker with setMaxItems(50) and the session's token,
 *     key and app id, and posts the picked ids, and nothing but the ids.
 *     Without the switch there is no "Add from Google Drive" at all.
 *
 * The API and Google's script are mocked; nothing else needs to be up. Run with
 * the switch both ways (Playwright starts `pnpm dev`, which inherits it):
 *   pnpm exec playwright test e2e/files-google-drive.spec.ts
 *   NEXT_PUBLIC_GOOGLE_DRIVE_PICKER=on pnpm exec playwright test e2e/files-google-drive.spec.ts
 */

const PICKER_BUILD = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_PICKER === "on";
const SCRIPT = "https://apis.google.com/js/api.js";
const PICKED = ["1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA", "1BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB"];

/** Google's loader and Picker, replaced: records what the app configured, then "picks" PICKED. */
const FAKE_PICKER_SCRIPT = `
window.__picker = {};
window.gapi = {
  load(name, options) {
    const record = window.__picker;
    class DocsView {
      constructor(viewId) { record.viewId = viewId; }
      setIncludeFolders(v) { record.includeFolders = v; return this; }
      setSelectFolderEnabled(v) { record.selectFolder = v; return this; }
    }
    class PickerBuilder {
      addView() { return this; }
      enableFeature(f) { record.feature = f; return this; }
      setMaxItems(n) { record.maxItems = n; return this; }
      setOAuthToken(t) { record.token = t; return this; }
      setDeveloperKey(k) { record.key = k; return this; }
      setAppId(a) { record.appId = a; return this; }
      setLocale(l) { record.locale = l; return this; }
      setCallback(cb) { this.cb = cb; return this; }
      build() {
        const cb = this.cb;
        return {
          setVisible() {
            setTimeout(() => cb({ action: "picked", docs: ${JSON.stringify(PICKED.map((id) => ({ id })))} }), 0);
          },
          dispose() {},
        };
      }
    }
    window.google = {
      picker: {
        Action: { PICKED: "picked", CANCEL: "cancel" },
        Feature: { MULTISELECT_ENABLED: "multiselect" },
        ViewId: { DOCS: "all" },
        DocsView,
        PickerBuilder,
      },
    };
    record.loaded = name;
    options.callback();
  },
};
`;

interface Recorded {
  googleRequests: string[];
  pickedBodies: string[];
}

async function mockApi(page: Page, opts: { dark: boolean }): Promise<Recorded> {
  const recorded: Recorded = { googleRequests: [], pickedBodies: [] };
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith("google.com")) {
      recorded.googleRequests.push(request.url());
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("klorn-token", "e2e-test-token");
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "u1",
          email: "operator@example.com",
          name: "Operator",
          plan: "PRO",
          role: "USER",
          timezone: "Asia/Seoul",
          googleConnected: true,
          googleNeedsReconnect: false,
          hasAnyMailSource: true,
          files: true,
        },
      },
    }),
  );
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/drive/files**", (route) =>
    route.fulfill({ json: { files: [], nextCursor: null } }),
  );
  await page.route("**/api/drive/google/accounts", (route) =>
    opts.dark
      ? route.fulfill({
          status: 404,
          json: { message: "Route GET:/api/drive/google/accounts not found" },
        })
      : route.fulfill({
          json: {
            accounts: [
              {
                id: "acct-1",
                email: "me@example.com",
                needsReconnect: false,
                createdAt: "2026-10-01T00:00:00.000Z",
              },
            ],
          },
        }),
  );
  await page.route("**/api/drive/google/accounts/acct-1/picker-session", (route) =>
    route.fulfill({
      headers: { "Cache-Control": "no-store" },
      json: { accessToken: "ya29.e2e-token", developerKey: "AIza-e2e-key", appId: "123456789012" },
    }),
  );
  await page.route("**/api/drive/google/accounts/acct-1/picked", (route) => {
    recorded.pickedBodies.push(route.request().postData() ?? "");
    return route.fulfill({ json: { added: 2, refused: [] } });
  });
  await page.route(SCRIPT, (route) =>
    route.fulfill({ contentType: "text/javascript", body: FAKE_PICKER_SCRIPT }),
  );
  return recorded;
}

async function openFiles(page: Page) {
  const accounts = page.waitForResponse("**/api/drive/google/accounts");
  await page.goto("/files");
  await page.getByText(en["files.empty.title"], { exact: true }).waitFor({ timeout: 90_000 });
  await accounts;
}

const pickerScriptsOnPage = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('script[src*="apis.google.com"]').length);

test("dark: nothing of Google Drive renders while its accounts route answers 404", async ({
  page,
}) => {
  const recorded = await mockApi(page, { dark: true });
  await openFiles(page);
  await expect(page.getByRole("heading", { name: en["files.google.title"] })).toHaveCount(0);
  await expect(page.getByRole("button", { name: en["files.google.connect"] })).toHaveCount(0);
  await expect(page.getByRole("button", { name: en["files.google.add"] })).toHaveCount(0);
  expect(recorded.googleRequests).toEqual([]);
  expect(await pickerScriptsOnPage(page)).toBe(0);
});

test("on: the section shows the account, and no Google script loads before a click", async ({
  page,
}) => {
  const recorded = await mockApi(page, { dark: false });
  await openFiles(page);
  await expect(page.getByRole("heading", { name: en["files.google.title"] })).toBeVisible();
  await expect(page.getByText("me@example.com", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: en["files.google.connect"] })).toBeVisible();
  await expect(page.getByRole("button", { name: en["files.google.add"] })).toHaveCount(
    PICKER_BUILD ? 1 : 0,
  );
  expect(recorded.googleRequests).toEqual([]);
  expect(await pickerScriptsOnPage(page)).toBe(0);
});

test("switch on: the click loads the Picker, configured as the session says, and posts ids only", async ({
  page,
}) => {
  test.skip(!PICKER_BUILD, "needs a build with NEXT_PUBLIC_GOOGLE_DRIVE_PICKER=on");
  const recorded = await mockApi(page, { dark: false });
  await openFiles(page);
  expect(recorded.googleRequests).toEqual([]);
  await page.getByRole("button", { name: en["files.google.add"] }).click();
  await expect.poll(() => recorded.pickedBodies.length).toBe(1);
  expect(recorded.googleRequests).toEqual([SCRIPT]);
  expect(JSON.parse(recorded.pickedBodies[0] ?? "")).toEqual({ ids: PICKED });
  const configured = await page.evaluate(
    () => (window as unknown as { __picker: Record<string, unknown> }).__picker,
  );
  expect(configured).toMatchObject({
    loaded: "picker",
    maxItems: 50,
    token: "ya29.e2e-token",
    key: "AIza-e2e-key",
    appId: "123456789012",
    selectFolder: false,
    locale: "en",
  });
  await expect(
    page.getByText(en["files.google.pick.added"].replace("{count}", "2"), { exact: true }),
  ).toBeVisible();
});
