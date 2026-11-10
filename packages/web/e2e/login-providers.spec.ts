import { expect, type Page, test } from "@playwright/test";

/**
 * The login page's two server-driven states and the contrast floors the
 * previous build broke.
 *
 * Both probes are mocked: the deployment's real BETA_GATE_ENABLED /
 * APPLE_LOGIN_ENABLED values must not decide whether these tests pass.
 */

type Provider = "google" | "apple" | "naver";

async function mockAuthProbes(
  page: Page,
  opts: { signupOpen: boolean; providers: Provider[]; providersDelayMs?: number },
) {
  await page.route("**/api/auth/signup-status", (route) =>
    route.fulfill({ json: { open: opts.signupOpen } }),
  );
  await page.route("**/api/auth/providers", async (route) => {
    if (opts.providersDelayMs) await new Promise((r) => setTimeout(r, opts.providersDelayMs));
    await route.fulfill({ json: { providers: opts.providers.map((id) => ({ id })) } });
  });
  // A stale seed from another test must not leak into the lane under test.
  await page.addInitScript(() => window.localStorage.removeItem("klorn.auth.providers.v1"));
}

/** WCAG 2.x relative luminance / contrast, computed on the live rendered DOM. */
const CONTRAST_HELPERS = `
  const parse = (c) => {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillStyle = c;
    const h = ctx.fillStyle;
    if (h.startsWith("#")) return [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16)).concat([1]);
    const m = h.match(/[\\d.]+/g).map(Number);
    return [m[0], m[1], m[2], m[3] === undefined ? 1 : m[3]];
  };
  const lum = (a) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]);
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const effBg = (el) => {
    let cur = el; const stack = [];
    while (cur) {
      const bg = parse(getComputedStyle(cur).backgroundColor);
      if (bg[3] > 0) stack.push(bg);
      if (bg[3] === 1) break;
      cur = cur.parentElement;
    }
    let base = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (base[3] !== 1) base = [255, 255, 255, 1];
    let out = [base[0], base[1], base[2]];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  };
  const contrast = (el) => {
    const fg = over(parse(getComputedStyle(el).color), effBg(el));
    const bg = effBg(el);
    const l1 = lum(fg), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
`;

function contrastOf(page: Page, selectorFn: string): Promise<number> {
  return page.evaluate(
    `(() => { ${CONTRAST_HELPERS} const el = ${selectorFn}; return contrast(el); })()`,
  );
}

const AA_TEXT = 4.5;

test.describe("Login — provider lane", () => {
  test("open signup lists every enabled provider", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google", "apple", "naver"] });
    await page.goto("/login");

    await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with Apple" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with Naver" })).toBeVisible();
    // Open signup means the create-account switch exists and no access wall is shown.
    await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();
    await expect(page.getByText("Klorn is invite-only.")).toBeHidden();
  });

  test("a disabled provider renders no button", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
    await page.goto("/login");

    await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with Apple" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Continue with Naver" })).toHaveCount(0);
  });

  test("Google survives a providers probe that never answers", async ({ page }) => {
    await page.route("**/api/auth/signup-status", (route) =>
      route.fulfill({ json: { open: true } }),
    );
    await page.route("**/api/auth/providers", (route) => route.abort());
    await page.goto("/login");

    await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  });

  test("provider rows meet the 44px touch-target floor", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google", "apple", "naver"] });
    await page.goto("/login");

    for (const name of ["Continue with Google", "Continue with Apple", "Continue with Naver"]) {
      const box = await page.getByRole("link", { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("a stale cache does not freeze the lane — a newly enabled provider appears", async ({
    page,
  }) => {
    await page.route("**/api/auth/signup-status", (route) =>
      route.fulfill({ json: { open: true } }),
    );
    // The server has since turned Apple on.
    await page.route("**/api/auth/providers", (route) =>
      route.fulfill({ json: { providers: [{ id: "google" }, { id: "apple" }] } }),
    );
    // The browser is holding a seed from before that, older than staleTime.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "klorn.auth.providers.v1",
        JSON.stringify({ at: Date.now() - 10 * 60_000, value: { providers: [{ id: "google" }] } }),
      );
    });
    await page.goto("/login");

    // Seeding react-query without initialDataUpdatedAt makes it treat the seed
    // as fetched-just-now on EVERY mount, so the query never refetches and the
    // stale list sticks for the cache's full 24h lifetime.
    await expect(page.getByRole("link", { name: "Continue with Apple" })).toBeVisible();
  });

  test("a cached provider list renders the full lane on first paint", async ({ page }) => {
    await page.route("**/api/auth/signup-status", (route) =>
      route.fulfill({ json: { open: true } }),
    );
    // The probe hangs, so anything rendered came from the seed alone.
    await page.route("**/api/auth/providers", () => {});
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "klorn.auth.providers.v1",
        JSON.stringify({
          at: Date.now(),
          value: { providers: [{ id: "google" }, { id: "apple" }] },
        }),
      );
    });
    await page.goto("/login");

    await expect(page.getByRole("link", { name: "Continue with Apple" })).toBeVisible();
  });
});

test.describe("Login — invite-only deployment", () => {
  test("leads with the access request and keeps sign-up closed", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: false, providers: ["google"] });
    await page.goto("/login");

    await expect(page.getByRole("link", { name: "Request early access" })).toBeVisible();
    await expect(page.getByText("Already approved? Sign in below.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create an account" })).toHaveCount(0);
  });
});

test.describe("Login — contrast floors", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`primary CTA clears AA in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockAuthProbes(page, { signupOpen: false, providers: ["google"] });
      await page.goto("/login");
      await expect(page.getByRole("link", { name: "Request early access" })).toBeVisible();

      const ratio = await contrastOf(
        page,
        `[...document.querySelectorAll("a")].find((a) => /Request early access/.test(a.textContent))`,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`access notice clears AA in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockAuthProbes(page, { signupOpen: false, providers: ["google"] });
      await page.goto("/login");
      await expect(page.getByText("Klorn is invite-only.")).toBeVisible();

      const ratio = await contrastOf(
        page,
        `document.querySelector("[data-testid='access-notice']")`,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`footer links clear AA in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
      await page.goto("/login");
      await expect(page.getByRole("link", { name: "Privacy" })).toBeVisible();

      const ratio = await contrastOf(
        page,
        `[...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Privacy")`,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`the mode-switch link clears AA in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
      await page.goto("/login");
      await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();

      const ratio = await contrastOf(
        page,
        `[...document.querySelectorAll("button")].find((b) => /Create an account/.test(b.textContent))`,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`the focus ring clears the non-text floor in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
      await page.goto("/login");
      const google = page.getByRole("link", { name: "Continue with Google" });
      await google.focus();

      // The ring used to fake its gap with a hardcoded white box-shadow, which
      // painted a bright white line around every focused control in the dark
      // theme. outline-offset draws the gap from the real backdrop instead.
      const ring = (await page.evaluate(
        `(() => { ${CONTRAST_HELPERS}
          const el = [...document.querySelectorAll("a")].find((a) => /Continue with Google/.test(a.textContent));
          const cs = getComputedStyle(el);
          const stroke = parse(cs.outlineColor);
          const bg = effBg(el);
          const l1 = lum(over(stroke, bg)), l2 = lum(bg);
          return {
            boxShadow: cs.boxShadow,
            width: Number.parseFloat(cs.outlineWidth),
            contrast: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
          };
        })()`,
      )) as { boxShadow: string; width: number; contrast: number };
      expect(ring.boxShadow).toBe("none");
      expect(ring.width).toBeGreaterThanOrEqual(2);
      // WCAG 1.4.11 non-text contrast.
      expect(ring.contrast).toBeGreaterThanOrEqual(3);
    });

    test(`the form title clears AA in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Sign in to Klorn" })).toBeVisible();

      const ratio = await contrastOf(
        page,
        `[...document.querySelectorAll("h2")].find((el) => el.textContent.trim() === "Sign in to Klorn")`,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`provider rows clear AA in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockAuthProbes(page, { signupOpen: true, providers: ["google", "apple", "naver"] });
      await page.goto("/login");
      await expect(page.getByRole("link", { name: "Continue with Naver" })).toBeVisible();

      const ratio = await contrastOf(
        page,
        `[...document.querySelectorAll("a")].find((a) => /Continue with Apple/.test(a.textContent))`,
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});

test.describe("Login — motion", () => {
  test("entry animation is dropped under prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockAuthProbes(page, { signupOpen: true, providers: ["google", "apple"] });
    await page.goto("/login");
    const google = page.getByRole("link", { name: "Continue with Google" });
    await google.waitFor();

    const names = await page.evaluate(() =>
      [...document.querySelectorAll(".rise")].map((el) => getComputedStyle(el).animationName),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n === "none")).toBe(true);
  });

  test("the staggered entry settles fully opaque", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google", "apple"] });
    await page.goto("/login");
    await page.getByRole("link", { name: "Continue with Apple" }).waitFor();
    // `both` fill holds the from-state; a wrong delay or a dropped keyframe
    // would strand a shelf at opacity 0 forever.
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Math.min(
            ...[...document.querySelectorAll(".rise")].map((el) =>
              Number(getComputedStyle(el).opacity),
            ),
          ),
        ),
      )
      .toBe(1);
  });
});

test.describe("Login — retired early-access funnel", () => {
  test("/early-access lands on the sign-up tab", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
    await page.goto("/early-access");

    await expect(page).toHaveURL(/\/login\?mode=register/);
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  });

  test("a redirect target rides through to the login page", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
    await page.goto("/early-access?next=%2Fbriefing");

    await expect(page).toHaveURL(/next=%2Fbriefing/);
  });

  test("the redirect cannot be pointed off-site", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
    await page.goto("/early-access?next=https%3A%2F%2Fevil.example");

    await expect(page).toHaveURL(/\/login\?mode=register$/);
  });

  test("inflow attribution survives the hop and reaches the Google URL", async ({ page }) => {
    await mockAuthProbes(page, { signupOpen: true, providers: ["google"] });
    await page.goto("/early-access?utm_source=hn&utm_medium=post");

    const google = page.getByRole("link", { name: "Continue with Google" });
    await expect(google).toBeVisible();
    // The capture happens on both surfaces; what matters is that the value
    // leaves with the request, since Google's leg exits our origin.
    await expect.poll(() => google.getAttribute("href")).toMatch(/attr=.*utm_source%3Dhn/);
  });
});
