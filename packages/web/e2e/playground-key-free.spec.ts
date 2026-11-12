import { expect, type Page, test } from "@playwright/test";
import { KLORN_MODEL_ID } from "../src/app/playground/models";
import en from "../src/lib/locales/en";

/**
 * Issue #1686 — the playground's key-free demo, from the client side.
 *
 * `PLAYGROUND_NO_KEY_DEMO_ENABLED` has been on in production while nothing
 * could reach the path: `ClassifyInput.apiKey` was a required `string` and the
 * hook always sent `apiKey: input.apiKey.trim()`, so a visitor read "bring its
 * key" while the server would have answered them for free.
 *
 * The wire rules themselves are unit-tested
 * (packages/api/src/__tests__/web-playground-key-free.test.ts); this pins the
 * wiring — which mode the form submits in, what opens the BYOK fields, and
 * that no refusal is a dead end.
 *
 * The API is mocked, so nothing else needs to be up and no model is called:
 *   E2E_BASE_URL=http://localhost:8123 pnpm exec playwright test e2e/playground-key-free.spec.ts
 */

const CLASSIFY = "**/api/playground/classify";
const ANTHROPIC_KEY_LABEL = en["playground.key.label"].replace("{provider}", "Anthropic");
const GOOGLE_KEY_LABEL = en["playground.key.label"].replace("{provider}", "Google");

interface CapturedBody {
  from?: string;
  subject?: string;
  snippet?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
}

/**
 * The model the stubbed server says it ran.
 *
 * It MUST stay different from the page's own `KLORN_MODEL_ID`
 * (`src/app/playground/models.ts`) and must render differently after
 * `shortModelName` strips the vendor prefix. The page falls back to that
 * constant when the response carries no model, so a stub whose value matches
 * it — including `anthropic/claude-haiku-5-5`, which shortens to exactly the
 * constant — passes on either arm and stops testing anything. Do not "tidy"
 * this to match the page.
 */
const SERVER_REPORTED_MODEL = "anthropic/claude-sonnet-5-5";
const SERVER_REPORTED_SHORT = "claude-sonnet-5-5";

/**
 * Answer every classify with one verdict; hand back the bodies we saw.
 *
 * `model` is what the server reports it ran on. Pass `null` for a server that
 * sends no model at all — an API deployed before the field existed, which is a
 * real state and not only a historical one: Vercel and Render do not ship
 * together, so a new client talks to the old API for a window on every deploy.
 */
async function stubVerdict(page: Page, model: string | null = SERVER_REPORTED_MODEL) {
  const bodies: CapturedBody[] = [];
  await page.route(CLASSIFY, async (route) => {
    bodies.push(route.request().postDataJSON() as CapturedBody);
    await route.fulfill({
      status: 200,
      json: {
        tier: "QUEUE",
        reason: "Colleague asking for same-day contract sign-off",
        features: { confidence: 0.6, senderTrust: 0.9, reversibility: 0.4, urgency: 0.9 },
        source: "llm",
        decidedBy: "default",
        ...(model === null ? {} : { model }),
      },
    });
  });
  return bodies;
}

/** Answer every classify with one refusal, shaped as the server sends it. */
async function stubRefusal(page: Page, status: number, body: Record<string, unknown>) {
  await page.route(CLASSIFY, (route) => route.fulfill({ status, json: body }));
}

const sortButton = (page: Page) => page.getByRole("button", { name: en["playground.submit"] });
/** One label, state on aria-pressed: it switches whose account pays. */
const byokToggle = (page: Page) => page.getByRole("button", { name: en["playground.byok.toggle"] });
const keyField = (page: Page, label = ANTHROPIC_KEY_LABEL) => page.getByLabel(label);
const resultPane = (page: Page) =>
  page.getByRole("region", { name: en["playground.result.label"] });
const verdict = (page: Page) => page.getByText(en["playground.headline.QUEUE"]);
/** Next renders its own empty role="alert" route announcer; match ours by title. */
const errorAlert = (page: Page) =>
  page.getByRole("alert").filter({ hasText: en["playground.error.title"] });

/** Seed a key the way "Remember this key on this device" leaves it. */
async function seedRememberedKey(page: Page, provider: string, key: string) {
  await page.addInitScript(
    ([p, k]) => {
      localStorage.setItem("klorn-playground-provider", p);
      localStorage.setItem(`klorn-playground-key-${p}`, k);
      localStorage.setItem(`klorn-playground-remember-${p}`, "1");
    },
    [provider, key] as const,
  );
}

test.describe("playground: key-free is the default door", () => {
  test("sorts with no key, and the request carries no apiKey at all", async ({ page }) => {
    const bodies = await stubVerdict(page);
    await page.goto("/playground");

    // Nothing typed, nothing revealed — the first click must already work.
    await sortButton(page).click();

    await expect(verdict(page)).toBeVisible();
    expect(bodies).toHaveLength(1);
    // Absent, not empty: the server routes on `!body.apiKey`, and the schema
    // sets minLength 8, so an empty string would be a 400, not a demo run.
    expect(bodies[0]).not.toHaveProperty("apiKey");
    expect(bodies[0]).not.toHaveProperty("provider");
    expect(bodies[0]).not.toHaveProperty("model");
    expect(bodies[0].subject).toBeTruthy();
  });

  test("says what the free sort runs on, and hides the key fields until asked", async ({
    page,
  }) => {
    await stubVerdict(page);
    await page.goto("/playground");

    await expect(page.getByText(/No key needed/)).toBeVisible();
    await expect(keyField(page)).toBeHidden();
    await expect(byokToggle(page)).toHaveAttribute("aria-pressed", "false");

    await byokToggle(page).click();
    await expect(keyField(page)).toBeVisible();
    await expect(byokToggle(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("nothing a visitor reads first asks them to go get a key", async ({ page }) => {
    await page.goto("/playground");
    const text = await page.locator("main").innerText();
    // "No key yet? Create one at Anthropic" lives inside the BYOK panel now, so
    // it is correct where it appears and absent where it used to be a wall.
    expect(text).not.toContain(en["playground.key.none"]);
    expect(text).toContain(en["playground.leadShort"].split(" — ")[0]);
  });

  test("the result names the model that actually ran, not the picker's", async ({ page }) => {
    await stubVerdict(page);
    await page.goto("/playground");
    await sortButton(page).click();

    // Defense 3 pins the demo to the server's JUDGE_MODEL whatever the picker
    // says, so naming anything else would be a model that never ran — and the
    // page must take that name from the response, not from its own build-time
    // constant, which is only what render.yaml is *supposed* to pin.
    await expect(resultPane(page)).toContainText(SERVER_REPORTED_SHORT);
    await expect(resultPane(page)).not.toContainText(KLORN_MODEL_ID);
  });

  test("falls back to the build constant when the server reports no model", async ({ page }) => {
    // Deploy skew, not just an old server: web and api ship separately, so a
    // new client meets the pre-field API on every release. An empty model name
    // on the card is worse than a stale-but-correct one.
    await stubVerdict(page, null);
    await page.goto("/playground");
    await sortButton(page).click();

    await expect(resultPane(page)).toContainText(KLORN_MODEL_ID);
  });
});

test.describe("playground: BYOK stays a real choice", () => {
  test("a key typed into the revealed field is the one that gets used", async ({ page }) => {
    const bodies = await stubVerdict(page);
    await page.goto("/playground");

    await byokToggle(page).click();
    await keyField(page).fill("sk-ant-visitorkey123");
    await sortButton(page).click();

    await expect(verdict(page)).toBeVisible();
    expect(bodies[0].apiKey).toBe("sk-ant-visitorkey123");
    expect(bodies[0].provider).toBe("anthropic");
    expect(bodies[0].model).toBe("claude-haiku-5-5");
  });

  test("a remembered key opens the section on load and is still sent", async ({ page }) => {
    const bodies = await stubVerdict(page);
    await seedRememberedKey(page, "gemini", "AIzaRememberedFromLastVisit");
    await page.goto("/playground");

    // They already chose BYOK once; hiding a key they can see is saved would be
    // the worse surprise.
    await expect(byokToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(keyField(page, GOOGLE_KEY_LABEL)).toHaveValue("AIzaRememberedFromLastVisit");

    await sortButton(page).click();
    await expect(verdict(page)).toBeVisible();
    expect(bodies[0].apiKey).toBe("AIzaRememberedFromLastVisit");
    expect(bodies[0].provider).toBe("gemini");
  });

  test("a key too short for the server's schema is named, not silently ignored", async ({
    page,
  }) => {
    const bodies = await stubVerdict(page);
    await page.goto("/playground");

    await byokToggle(page).click();
    await keyField(page).fill("sk-abc");
    await sortButton(page).click();

    await expect(errorAlert(page)).toContainText(/too short/i);
    // Falling back to Klorn's free sort here would spend Klorn's money on a
    // visitor who believes their own key paid for it.
    expect(bodies).toHaveLength(0);
  });

  test("switching back to the free sort with a key typed is honoured, not ignored", async ({
    page,
  }) => {
    // Deliberate, and pinned here so it is not mistaken for a slip later: the
    // control is unpressed and the note above it says Klorn's account pays, so
    // the free sort is what was asked for. The key stays typed, because turning
    // it back on should cost nothing.
    const bodies = await stubVerdict(page);
    await page.goto("/playground");

    await byokToggle(page).click();
    await keyField(page).fill("sk-ant-visitorkey123");
    await byokToggle(page).click();
    await sortButton(page).click();

    await expect(verdict(page)).toBeVisible();
    expect(bodies[0]).not.toHaveProperty("apiKey");

    // Turning it back on uses the key that is still there — no retyping.
    await byokToggle(page).click();
    await expect(keyField(page)).toHaveValue("sk-ant-visitorkey123");
    await sortButton(page).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1].apiKey).toBe("sk-ant-visitorkey123");
  });

  test("an empty key field in BYOK still asks for the key", async ({ page }) => {
    const bodies = await stubVerdict(page);
    await page.goto("/playground");

    await byokToggle(page).click();
    await sortButton(page).click();

    await expect(errorAlert(page)).toContainText(
      en["playground.error.noKey"].replace("{provider}", "Anthropic"),
    );
    expect(bodies).toHaveLength(0);
  });
});

test.describe("playground: a refusal only switches the form when a key is the way out", () => {
  test("a spent daily budget says so, opens the key fields, and is never a price", async ({
    page,
  }) => {
    await stubRefusal(page, 429, { error: "demo_budget_exhausted", byokAvailable: true });
    await page.goto("/playground");
    await sortButton(page).click();

    const alert = errorAlert(page);
    await expect(alert).toContainText(en["playground.error.demoBudget"]);
    await expect(alert).not.toContainText(/upgrade|subscribe|pay|plan/i);
    await expect(keyField(page)).toBeVisible();
    await expect(byokToggle(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("the demo being dark falls back to BYOK instead of a dead end", async ({ page }) => {
    await stubRefusal(page, 401, { error: "key_required" });
    await page.goto("/playground");
    await sortButton(page).click();

    await expect(errorAlert(page)).toContainText(en["playground.error.demoOff"]);
    await expect(keyField(page)).toBeVisible();
  });

  test("a per-IP demo limit leaves the form free, so its own advice can be taken", async ({
    page,
  }) => {
    // The copy says to try again in a minute. If the refusal flipped the form
    // to BYOK, the next click would answer that advice by demanding a key.
    const bodies: Array<Record<string, unknown>> = [];
    let refuse = true;
    await page.route(CLASSIFY, async (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (refuse) {
        return route.fulfill({
          status: 429,
          json: { error: "demo_rate_limited", byokAvailable: true },
        });
      }
      return route.fulfill({
        status: 200,
        json: {
          tier: "QUEUE",
          reason: "Colleague asking for same-day contract sign-off",
          features: { confidence: 0.6, senderTrust: 0.9, reversibility: 0.4, urgency: 0.9 },
          source: "llm",
        },
      });
    });

    await page.goto("/playground");
    await sortButton(page).click();
    await expect(errorAlert(page)).toContainText(en["playground.error.demoRateLimited"]);
    await expect(byokToggle(page)).toHaveAttribute("aria-pressed", "false");

    // The minute passes: the retry must be a free sort, not a demand for a key.
    refuse = false;
    await sortButton(page).click();
    await expect(verdict(page)).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("apiKey");
  });

  test("a demo-side outage is not blamed on the visitor's key", async ({ page }) => {
    await stubRefusal(page, 502, {
      error: "Demo classification failed — try again shortly, or use your own API key.",
      byokAvailable: true,
    });
    await page.goto("/playground");
    await sortButton(page).click();

    const alert = errorAlert(page);
    await expect(alert).toContainText(en["playground.error.demoFailed"]);
    await expect(alert).not.toContainText(en["playground.error.failed"]);
    // "Try again shortly" has to stay possible, same as the rate limit.
    await expect(byokToggle(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("an infrastructure 500 in demo mode never blames a key the visitor never gave", async ({
    page,
  }) => {
    // error-handler.ts answers a 5xx with `{ error: "Internal server error" }` —
    // no byokAvailable marker, so only the mode tells the client what happened.
    await stubRefusal(page, 500, { error: "Internal server error" });
    await page.goto("/playground");
    await sortButton(page).click();

    await expect(errorAlert(page)).toContainText(en["playground.error.demoFailed"]);
    await expect(errorAlert(page)).not.toContainText(en["playground.error.failed"]);
  });

  test("the route limiter's own 429 still reads as too many requests", async ({ page }) => {
    // @fastify/rate-limit throws an Error that error-handler.ts re-sends as
    // `{ error: "Rate limit exceeded, retry in …" }` — none of our codes.
    await stubRefusal(page, 429, { error: "Rate limit exceeded, retry in 1 minute" });
    await page.goto("/playground");
    await sortButton(page).click();

    await expect(errorAlert(page)).toContainText(en["playground.error.rateLimited"]);
    // A wait is not a reason to push the visitor into finding a key.
    await expect(keyField(page)).toBeHidden();
  });
});
