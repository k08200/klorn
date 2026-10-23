import { expect, type Page, test } from "@playwright/test";
import en from "../src/lib/locales/en";

/**
 * D3's web UI step (docs/providers/unified-platform-plan.md) — /files › Klorn
 * Drive.
 *
 *   - Dark: while GET /api/drive/limits answers Fastify's default 404 nothing
 *     of it renders, and the subtitle still says the page is read-only.
 *   - Live: the storage line, "Upload files" and "New folder"; an upload sends
 *     `size`, then `parentExternalId` (only inside a folder), then `file`; a
 *     file over `maxFileBytes` is refused without a request; Rename sends
 *     PATCH { name } for a Klorn row; a Google row has no "More actions".
 *
 * The API is mocked; nothing else needs to be up:
 *   pnpm exec playwright test e2e/files-klorn-drive.spec.ts
 */

const KLORN_ROW = {
  id: "row-1",
  provider: "KLORN",
  sourceKey: "klorn",
  externalId: "ext-1",
  name: "report.pdf",
  mimeType: "application/pdf",
  isFolder: false,
  sizeBytes: 2048,
  parentExternalId: null,
  modifiedAt: "2026-10-20T00:00:00.000Z",
  webUrl: null,
  readOnly: false,
};
const GOOGLE_ROW = {
  ...KLORN_ROW,
  id: "row-g",
  provider: "GOOGLE",
  sourceKey: "acct-1",
  externalId: "g-1",
  name: "shared.docx",
  webUrl: "https://docs.google.com/document/d/g-1",
  readOnly: true,
};
const SMALL_CAP_BYTES = 10;

interface Recorded {
  uploads: string[];
  patches: string[];
}

async function mockApi(page: Page, opts: { live: boolean }): Promise<Recorded> {
  const recorded: Recorded = { uploads: [], patches: [] };
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
  await page.route("**/api/drive/limits", (route) =>
    opts.live
      ? route.fulfill({
          headers: { "Cache-Control": "no-store" },
          json: { maxFileBytes: SMALL_CAP_BYTES, quotaBytes: 1024 ** 3, usedBytes: 2048 },
        })
      : route.fulfill({
          status: 404,
          json: {
            message: "Route GET:/api/drive/limits not found",
            error: "Not Found",
            statusCode: 404,
          },
        }),
  );
  await page.route("**/api/drive/files**", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      recorded.uploads.push(request.postDataBuffer()?.toString("latin1") ?? "");
      return route.fulfill({ status: 201, json: { file: { ...KLORN_ROW, id: "row-new" } } });
    }
    if (request.method() === "PATCH") {
      recorded.patches.push(request.postData() ?? "");
      return route.fulfill({ json: { file: { ...KLORN_ROW, name: "renamed.pdf" } } });
    }
    return route.fulfill({ json: { files: [KLORN_ROW, GOOGLE_ROW], nextCursor: null } });
  });
  return recorded;
}

async function openFiles(page: Page) {
  const limits = page.waitForResponse("**/api/drive/limits");
  await page.goto("/files");
  await page.getByText(KLORN_ROW.name, { exact: true }).waitFor({ timeout: 90_000 });
  await limits;
}

const actionsFor = (name: string) => en["files.drive.actions"].replace("{name}", name);

test("dark: no Klorn Drive controls while its limits answer 404", async ({ page }) => {
  await mockApi(page, { live: false });
  await openFiles(page);
  await expect(page.getByText(en["files.subtitle"], { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: en["files.drive.title"] })).toHaveCount(0);
  await expect(page.getByRole("button", { name: en["files.drive.upload"] })).toHaveCount(0);
  await expect(page.getByRole("button", { name: en["files.drive.newFolder"] })).toHaveCount(0);
  await expect(page.getByRole("button", { name: actionsFor(KLORN_ROW.name) })).toHaveCount(0);
});

test("live: the controls, and a menu on the Klorn row only", async ({ page }) => {
  await mockApi(page, { live: true });
  await openFiles(page);
  await expect(page.getByText(en["files.subtitle.live"], { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: en["files.drive.title"] })).toBeVisible();
  await expect(page.getByText("2 KB of 1 GB used", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: en["files.drive.upload"] })).toBeVisible();
  await expect(page.getByRole("button", { name: en["files.drive.newFolder"] })).toBeVisible();
  await expect(page.getByRole("button", { name: actionsFor(KLORN_ROW.name) })).toBeVisible();
  await expect(page.getByRole("button", { name: actionsFor(GOOGLE_ROW.name) })).toHaveCount(0);
});

test("upload: fields before the file, and a file over the cap is never sent", async ({ page }) => {
  const recorded = await mockApi(page, { live: true });
  await openFiles(page);
  const input = page.locator('input[type="file"]');
  await input.setInputFiles([
    { name: "ok.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
    {
      name: "big.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x".repeat(SMALL_CAP_BYTES + 1)),
    },
  ]);
  const summary = en["files.drive.upload.summary"].replace("{done}", "1").replace("{failed}", "1");
  await expect(page.getByText(summary, { exact: true })).toBeVisible();
  expect(recorded.uploads).toHaveLength(1);
  const body = recorded.uploads[0] ?? "";
  const size = body.indexOf('name="size"');
  const file = body.indexOf('name="file"');
  expect(size).toBeGreaterThanOrEqual(0);
  expect(file).toBeGreaterThan(size);
  // At the top level there is no parent field.
  expect(body).not.toContain('name="parentExternalId"');
  await expect(
    page.getByText(en["files.drive.error.tooLarge"].replace("{limit}", "10 B"), { exact: true }),
  ).toBeVisible();
});

test("rename: PATCH with the new name from the row's menu", async ({ page }) => {
  const recorded = await mockApi(page, { live: true });
  await openFiles(page);
  await page.getByRole("button", { name: actionsFor(KLORN_ROW.name) }).click();
  await page.getByRole("menuitem", { name: en["files.drive.rename"] }).click();
  const field = page.getByLabel(en["files.drive.rename.label"], { exact: true });
  await expect(field).toHaveValue(KLORN_ROW.name);
  await field.fill("renamed.pdf");
  await page.getByRole("button", { name: en["files.drive.rename.save"] }).click();
  await expect.poll(() => recorded.patches.length).toBe(1);
  expect(JSON.parse(recorded.patches[0] ?? "")).toEqual({ name: "renamed.pdf" });
});
