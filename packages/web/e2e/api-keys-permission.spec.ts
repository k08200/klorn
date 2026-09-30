import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import de from "../src/lib/locales/de";
import en from "../src/lib/locales/en";
import es from "../src/lib/locales/es";
import fr from "../src/lib/locales/fr";
import ja from "../src/lib/locales/ja";
import ko from "../src/lib/locales/ko";
import zh from "../src/lib/locales/zh";

/**
 * Step A3 (docs/providers/unified-platform-plan.md) — Settings › MCP API keys:
 * the read-only / read-and-write choice and the per-key "Agent activity" list.
 *
 * Both appear ONLY while GET /api/keys reports `writeToolsAvailable: true`.
 * While it is absent the section must render exactly as before this step; that
 * is pinned against markup captured from the pre-A3 component
 * (e2e/golden/api-keys-section-flag-off-*.html), not against a description of it.
 *
 * Run (the API is mocked; nothing else needs to be up):
 *   E2E_BASE_URL=http://localhost:8123 pnpm exec playwright test e2e/api-keys-permission.spec.ts
 */

const LOCALES = { en, ko, ja, zh, es, fr, de } as const;
type LocaleCode = keyof typeof LOCALES;

const GOLDEN_DIR = new URL("./golden/", import.meta.url);
const golden = (name: string) => readFileSync(new URL(name, GOLDEN_DIR), "utf8").trimEnd();

interface KeyWire {
  id: string;
  name: string;
  prefix: string;
  permission: "read" | "read_write";
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

interface ActivityWire {
  tool: string;
  outcome: "attempted" | "ok" | "refused" | "error";
  reason: string | null;
  targetId: string | null;
  createdAt: string;
}

/** Same three keys the golden files were captured with (incl. a stored read-write key). */
const KEYS: KeyWire[] = [
  {
    id: "k1",
    name: "laptop",
    prefix: "klorn_sk_ab12cd",
    permission: "read",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: null,
    revoked: false,
  },
  {
    id: "k2",
    name: "agent",
    prefix: "klorn_sk_ff00aa",
    permission: "read_write",
    createdAt: "2026-07-01T00:00:00.000Z",
    lastUsedAt: "2026-07-02T00:00:00.000Z",
    revoked: false,
  },
  {
    id: "k3",
    name: "old",
    prefix: "klorn_sk_0011ee",
    permission: "read",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: null,
    revoked: true,
  },
];

/** Revoked read-write key: its history stays readable. */
const REVOKED_RW: KeyWire = {
  id: "k4",
  name: "retired-agent",
  prefix: "klorn_sk_99aa77",
  permission: "read_write",
  createdAt: "2026-05-01T00:00:00.000Z",
  lastUsedAt: null,
  revoked: true,
};

/** Newest first, as the API returns them. */
const ACTIVITY: ActivityWire[] = [
  {
    tool: "mark_read",
    outcome: "ok",
    reason: null,
    targetId: "19a1",
    createdAt: "2026-09-30T12:00:00.000Z",
  },
  {
    tool: "mark_read",
    outcome: "refused",
    reason: "rate_limited",
    targetId: "19a2",
    createdAt: "2026-09-30T11:00:00.000Z",
  },
  {
    tool: "mark_read",
    outcome: "error",
    reason: "tool_error",
    targetId: null,
    createdAt: "2026-09-30T10:00:00.000Z",
  },
  {
    tool: "mark_read",
    outcome: "attempted",
    reason: null,
    targetId: "19a3",
    createdAt: "2026-09-30T09:00:00.000Z",
  },
];

interface MockOptions {
  keys: KeyWire[];
  /** Sent verbatim when defined; omitted from the body when undefined (flag OFF). */
  writeToolsAvailable?: boolean;
  activity?: ActivityWire[];
  activityStatus?: number;
  language?: LocaleCode;
}

interface Recorded {
  createBodies: string[];
  activityUrls: string[];
}

async function mockApi(page: Page, opts: MockOptions): Promise<Recorded> {
  const recorded: Recorded = { createBodies: [], activityUrls: [] };
  await page.addInitScript((language) => {
    localStorage.setItem("klorn-token", "e2e-test-token");
    if (language) localStorage.setItem("klorn-profile", JSON.stringify({ language }));
  }, opts.language);
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "u1",
          email: "operator@example.com",
          name: "Operator",
          plan: "FREE",
          role: "USER",
          timezone: "Asia/Seoul",
          googleConnected: true,
          googleNeedsReconnect: false,
          hasAnyMailSource: true,
        },
      },
    }),
  );
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/keys", (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      recorded.createBodies.push(request.postData() ?? "");
      return route.fulfill({
        json: {
          id: "k-new",
          name: "x",
          prefix: "klorn_sk_new000",
          permission: "read",
          key: "klorn_sk_secret",
        },
      });
    }
    const body: Record<string, unknown> = { keys: opts.keys };
    if (opts.writeToolsAvailable !== undefined) body.writeToolsAvailable = opts.writeToolsAvailable;
    return route.fulfill({ json: body });
  });
  await page.route("**/api/keys/*/activity", (route) => {
    recorded.activityUrls.push(new URL(route.request().url()).pathname);
    if (opts.activityStatus && opts.activityStatus !== 200) {
      return route.fulfill({ status: opts.activityStatus, json: { error: "boom" } });
    }
    return route.fulfill({ json: { activity: opts.activity ?? [] } });
  });
  return recorded;
}

/** The component's root element: the parent of its intro paragraph. */
async function openSection(page: Page, language: LocaleCode = "en"): Promise<Locator> {
  await page.goto("/settings");
  const intro = page.getByText(LOCALES[language]["settings.apiKeys.intro"], { exact: true });
  await intro.waitFor({ timeout: 90_000 });
  return intro.locator("..");
}

const outerHtml = (root: Locator) => root.evaluate((el) => el.outerHTML);

/** The region a disclosure button controls. */
async function controlledPanel(root: Locator, toggle: Locator): Promise<Locator> {
  return root.locator(`#${await toggle.getAttribute("aria-controls")}`);
}

test.describe("API keys — write tools OFF (the section as it was before A3)", () => {
  for (const [label, flag] of [
    ["field absent", undefined],
    ["field false", false],
  ] as const) {
    test(`populated list renders byte-identically (${label})`, async ({ page }) => {
      await mockApi(page, { keys: KEYS, writeToolsAvailable: flag });
      const root = await openSection(page);
      await expect(root.getByText("laptop")).toBeVisible();
      expect(await outerHtml(root)).toBe(golden("api-keys-section-flag-off-populated.html"));
    });
  }

  test("empty list renders byte-identically", async ({ page }) => {
    await mockApi(page, { keys: [] });
    const root = await openSection(page);
    await expect(root.getByText(en["settings.apiKeys.empty"])).toBeVisible();
    expect(await outerHtml(root)).toBe(golden("api-keys-section-flag-off-empty.html"));
  });

  test("offers no permission choice and no activity, even for a stored read-write key", async ({
    page,
  }) => {
    await mockApi(page, { keys: KEYS });
    const root = await openSection(page);
    await expect(root.getByText("klorn_sk_ff00aa…")).toBeVisible();
    await expect(root.getByRole("radio")).toHaveCount(0);
    await expect(root.getByRole("group")).toHaveCount(0);
    await expect(root.getByText(en["settings.apiKeys.permission.readWrite"])).toHaveCount(0);
    await expect(root.getByText(en["settings.apiKeys.activity.toggle"])).toHaveCount(0);
  });

  test("creating a key posts exactly { name }, as before", async ({ page }) => {
    const recorded = await mockApi(page, { keys: [] });
    const root = await openSection(page);
    await root.getByPlaceholder(en["settings.apiKeys.namePlaceholder"]).fill("laptop");
    await root.getByRole("button", { name: en["settings.apiKeys.create"] }).click();
    await expect(page.getByText(en["settings.apiKeys.createdNotice"])).toBeVisible();
    expect(recorded.createBodies).toEqual(['{"name":"laptop"}']);
  });
});

test.describe("API keys — write tools ON", () => {
  test("offers Read only (default) and Read and write, with what read-write allows", async ({
    page,
  }) => {
    await mockApi(page, { keys: [], writeToolsAvailable: true });
    const root = await openSection(page);
    const group = root.getByRole("group", { name: en["settings.apiKeys.permission.legend"] });
    await expect(group).toBeVisible();
    const readOnly = group.getByRole("radio", { name: en["settings.apiKeys.permission.read"] });
    const readWrite = group.getByRole("radio", {
      name: en["settings.apiKeys.permission.readWrite"],
    });
    await expect(readOnly).toBeChecked();
    await expect(readWrite).not.toBeChecked();
    const note = en["settings.apiKeys.permission.readWriteNote"];
    await expect(root.getByText(note, { exact: true })).toBeVisible();
    await expect(readWrite).toHaveAccessibleDescription(note);
  });

  test("creates a read key by default and a read-write key when chosen", async ({ page }) => {
    const recorded = await mockApi(page, { keys: [], writeToolsAvailable: true });
    const root = await openSection(page);
    const name = root.getByPlaceholder(en["settings.apiKeys.namePlaceholder"]);
    const create = root.getByRole("button", { name: en["settings.apiKeys.create"] });

    await name.fill("laptop");
    await create.click();
    await expect(page.getByText(en["settings.apiKeys.createdNotice"])).toBeVisible();

    await root.getByRole("button", { name: en["settings.apiKeys.dismiss"] }).click();
    await name.fill("agent");
    await root.getByRole("radio", { name: en["settings.apiKeys.permission.readWrite"] }).check();
    await create.click();
    await expect.poll(() => recorded.createBodies.length).toBe(2);
    expect(recorded.createBodies).toEqual([
      '{"name":"laptop","permission":"read"}',
      '{"name":"agent","permission":"read_write"}',
    ]);
  });

  test("the radios are keyboard-operable as one group", async ({ page }) => {
    await mockApi(page, { keys: [], writeToolsAvailable: true });
    const root = await openSection(page);
    const readOnly = root.getByRole("radio", { name: en["settings.apiKeys.permission.read"] });
    const readWrite = root.getByRole("radio", {
      name: en["settings.apiKeys.permission.readWrite"],
    });
    await readOnly.focus();
    await page.keyboard.press("ArrowDown");
    await expect(readWrite).toBeChecked();
    await expect(readWrite).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(readOnly).toBeChecked();
  });

  test("each key shows its permission; only read-write keys offer Agent activity", async ({
    page,
  }) => {
    await mockApi(page, { keys: [...KEYS, REVOKED_RW], writeToolsAvailable: true });
    const root = await openSection(page);
    const rows = root.getByRole("listitem");
    const read = en["settings.apiKeys.permission.read"];
    const readWrite = en["settings.apiKeys.permission.readWrite"];
    await expect(rows.filter({ hasText: "laptop" })).toContainText(read);
    await expect(rows.filter({ hasText: "agent" }).first()).toContainText(readWrite);
    await expect(rows.filter({ hasText: "old" })).toContainText(read);
    await expect(rows.filter({ hasText: "retired-agent" })).toContainText(readWrite);

    const toggle = (n: string) =>
      root.getByRole("button", { name: `${en["settings.apiKeys.activity.toggle"]} for ${n}` });
    await expect(toggle("agent")).toHaveCount(1);
    await expect(toggle("retired-agent")).toHaveCount(1);
    await expect(toggle("laptop")).toHaveCount(0);
    await expect(toggle("old")).toHaveCount(0);
  });

  test("expanding lists time, action and outcome, newest first; collapsing hides it", async ({
    page,
  }) => {
    const recorded = await mockApi(page, {
      keys: KEYS,
      writeToolsAvailable: true,
      activity: ACTIVITY,
    });
    const root = await openSection(page);
    const toggle = root.getByRole("button", { name: /Agent activity for agent/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(recorded.activityUrls).toEqual([]);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = await controlledPanel(root, toggle);
    const items = panel.getByRole("listitem");
    await expect(items).toHaveCount(ACTIVITY.length);
    // `next dev` runs effects twice (React StrictMode), so count distinct URLs: only
    // the expanded key is ever requested.
    expect([...new Set(recorded.activityUrls)]).toEqual(["/api/keys/k2/activity"]);

    const stamps = await panel
      .locator("time")
      .evaluateAll((els) => els.map((el) => el.getAttribute("datetime")));
    expect(stamps).toEqual(ACTIVITY.map((a) => a.createdAt));

    await expect(items.nth(0)).toContainText(en["settings.apiKeys.activity.tool.mark_read"]);
    await expect(items.nth(0)).toContainText(en["settings.apiKeys.activity.outcome.ok"]);
    await expect(items.nth(1)).toContainText(en["settings.apiKeys.activity.outcome.refused"]);
    await expect(items.nth(1)).toContainText(en["settings.apiKeys.activity.reason.rate_limited"]);
    await expect(items.nth(2)).toContainText(en["settings.apiKeys.activity.outcome.error"]);
    await expect(items.nth(2)).toContainText(en["settings.apiKeys.activity.reason.tool_error"]);
    await expect(items.nth(3)).toContainText(en["settings.apiKeys.activity.outcome.attempted"]);
    // The opaque message id is not user-facing.
    await expect(panel).not.toContainText("19a1");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toHaveCount(0);
  });

  test("the activity disclosure works from the keyboard alone", async ({ page }) => {
    await mockApi(page, { keys: KEYS, writeToolsAvailable: true, activity: ACTIVITY });
    const root = await openSection(page);
    const toggle = root.getByRole("button", { name: /Agent activity for agent/ });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      root.getByText(en["settings.apiKeys.activity.outcome.ok"], { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("says so when there is no activity", async ({ page }) => {
    await mockApi(page, { keys: KEYS, writeToolsAvailable: true, activity: [] });
    const root = await openSection(page);
    await root.getByRole("button", { name: /Agent activity for agent/ }).click();
    await expect(root.getByText(en["settings.apiKeys.activity.empty"])).toBeVisible();
  });

  test("says so when the activity cannot be loaded", async ({ page }) => {
    await mockApi(page, { keys: KEYS, writeToolsAvailable: true, activityStatus: 500 });
    const root = await openSection(page);
    await root.getByRole("button", { name: /Agent activity for agent/ }).click();
    await expect(root.getByText(en["settings.apiKeys.activity.loadFailed"])).toBeVisible();
  });

  test("new controls are at least 44px tall and show a visible focus ring", async ({ page }) => {
    await mockApi(page, { keys: KEYS, writeToolsAvailable: true, activity: ACTIVITY });
    const root = await openSection(page);
    const toggle = root.getByRole("button", { name: /Agent activity for agent/ });
    const targets = [
      root.getByText(en["settings.apiKeys.permission.read"], { exact: true }).first(),
      root.getByText(en["settings.apiKeys.permission.readWrite"], { exact: true }).first(),
      toggle,
      root.getByRole("button", { name: en["settings.apiKeys.revoke"] }).first(),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    for (const control of [
      root.getByRole("radio", { name: en["settings.apiKeys.permission.read"] }),
      toggle,
    ]) {
      await control.focus();
      const outline = await control.evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.outlineWidth, style: s.outlineStyle };
      });
      expect(outline).toEqual({ width: "2px", style: "solid" });
    }
  });

  test("respects prefers-reduced-motion: nothing in the section animates or transitions", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockApi(page, { keys: KEYS, writeToolsAvailable: true, activity: ACTIVITY });
    const root = await openSection(page);
    await root.getByRole("button", { name: /Agent activity for agent/ }).click();
    await expect(
      root.getByText(en["settings.apiKeys.activity.outcome.ok"], { exact: true }),
    ).toBeVisible();
    const motion = await root.evaluate((el) =>
      [el, ...el.querySelectorAll("*")].flatMap((node) => {
        const s = getComputedStyle(node);
        const longestMs = Math.max(
          ...s.transitionDuration.split(",").map((d) => Number.parseFloat(d) * 1000),
        );
        const animated =
          s.animationName !== "none" && Number.parseFloat(s.animationDuration) > 0.00001;
        return longestMs > 0.05 || animated ? [node.outerHTML.slice(0, 80)] : [];
      }),
    );
    expect(motion).toEqual([]);
  });
});

const NEW_KEYS = Object.keys(en).filter(
  (key) =>
    key.startsWith("settings.apiKeys.permission.") || key.startsWith("settings.apiKeys.activity."),
);

/** Words that are genuinely the same in another language. Keep this list tiny. */
const SAME_AS_ENGLISH: Record<string, LocaleCode[]> = {
  "settings.apiKeys.activity.outcome.error": ["es"],
};

test.describe("API keys — copy in every web locale", () => {
  test("every A3 string exists in all seven locales and is not English text in disguise", () => {
    expect(NEW_KEYS.length).toBeGreaterThanOrEqual(17);
    for (const [code, table] of Object.entries(LOCALES) as [LocaleCode, Record<string, string>][]) {
      for (const key of NEW_KEYS) {
        expect(table[key], `${code} is missing ${key}`).toBeTruthy();
        if (code === "en" || SAME_AS_ENGLISH[key]?.includes(code)) continue;
        expect(table[key], `${code} ${key} is still the English text`).not.toBe(en[key]);
      }
    }
  });

  for (const code of Object.keys(LOCALES) as LocaleCode[]) {
    test(`renders the choice, the permission and the activity list in ${code}`, async ({
      page,
    }) => {
      const T = LOCALES[code];
      await mockApi(page, {
        keys: KEYS,
        writeToolsAvailable: true,
        activity: ACTIVITY,
        language: code,
      });
      const root = await openSection(page, code);
      await expect(
        root.getByRole("group", { name: T["settings.apiKeys.permission.legend"] }),
      ).toBeVisible();
      await expect(
        root.getByRole("radio", { name: T["settings.apiKeys.permission.readWrite"] }),
      ).toBeVisible();
      await expect(root.getByText(T["settings.apiKeys.permission.readWriteNote"])).toBeVisible();

      const toggle = root.getByRole("button", {
        name: T["settings.apiKeys.activity.toggleFor"].replace("{name}", "agent"),
      });
      await toggle.click();
      const panel = await controlledPanel(root, toggle);
      const items = panel.getByRole("listitem");
      await expect(items).toHaveCount(ACTIVITY.length);
      await expect(items.nth(0)).toContainText(T["settings.apiKeys.activity.tool.mark_read"]);
      await expect(items.nth(0)).toContainText(T["settings.apiKeys.activity.outcome.ok"]);
      await expect(items.nth(1)).toContainText(T["settings.apiKeys.activity.reason.rate_limited"]);

      // A missing key renders as the raw key string; none may be on screen.
      expect(await root.innerText()).not.toContain("settings.apiKeys.");
    });
  }
});
