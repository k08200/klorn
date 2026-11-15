/**
 * The fixed-host app-password IMAP presets on the web (provider phase 2): the
 * metadata table (web/src/lib/imap-presets.ts) that drives ONE Settings card and
 * one first-run sheet per preset, the connect-failure wording
 * (web/src/components/imap-connect-error.ts), and the read-only generic IMAP card.
 * Run from the api suite because the web package has no unit-test runner.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyImapConnectFailure } from "../../../web/src/components/imap-connect-error";
import {
  accountSectionId,
  genericImapAccounts,
  genericImapProblemKey,
  PROVIDER_LABEL,
} from "../../../web/src/lib/account-health";
import {
  INITIAL_PRESET_PROBE,
  latestOnly,
  type PresetProbe,
  type PresetStatus,
  presetCardView,
  presetProbeReducer,
} from "../../../web/src/lib/imap-preset-status";
import { IMAP_PRESETS, imapPresetFor } from "../../../web/src/lib/imap-presets";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import { sourceGlyph } from "../../../web/src/lib/source-provider";
import { IMAP_PRESET_KEYS, imapPresetRouteSlug } from "../mail/imap-preset-keys";

const WEB = join(__dirname, "../../../web/src");
const read = (path: string) => readFileSync(join(WEB, path), "utf8");

const LOCALES = { en, ko, ja, zh, de, fr, es } as const;

/** The provider's own instructions, read on 2026-11-14. */
const HELP_URL: Record<string, string> = {
  DAUM: "https://cs.daum.net/faq/service/43/category/9234/detail/24081",
  KAKAO: "https://cs.kakao.com/helps_html/1073209983",
  YAHOO: "https://help.yahoo.com/kb/SLN15241.html",
  AOL: "https://help.aol.com/articles/create-and-manage-app-password",
  FASTMAIL: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
  ZOHO: "https://www.zoho.com/mail/help/imap-access.html",
  ZOHOPRO: "https://www.zoho.com/mail/help/imap-access.html",
};

describe("IMAP_PRESETS", () => {
  it("lists exactly the server's presets, in the server's display order", () => {
    expect(IMAP_PRESETS.map((preset) => preset.provider)).toEqual([...IMAP_PRESET_KEYS]);
  });

  it("calls each preset's own routes: /api/<slug>-imap with the server's slug", () => {
    for (const preset of IMAP_PRESETS) {
      expect(preset.slug).toBe(imapPresetRouteSlug(preset.provider));
    }
  });

  it("links each preset to the provider's own help page, over https", () => {
    for (const preset of IMAP_PRESETS) {
      expect(preset.helpUrl, preset.provider).toBe(HELP_URL[preset.provider]);
    }
  });

  it("finds a preset by provider, and nothing for a provider that is not one", () => {
    expect(imapPresetFor("YAHOO")?.slug).toBe("yahoo");
    expect(imapPresetFor("ICLOUD")).toBeNull();
    expect(imapPresetFor("IMAP")).toBeNull();
    expect(imapPresetFor("")).toBeNull();
  });

  it("names every preset in Account health and on the source badge", () => {
    expect(IMAP_PRESETS.map((preset) => PROVIDER_LABEL[preset.provider])).toEqual([
      "Daum Mail",
      "Kakao Mail",
      "Yahoo Mail",
      "AOL Mail",
      "Fastmail",
      "Zoho Mail",
      "Zoho Mail (organization)",
    ]);
    for (const preset of IMAP_PRESETS) {
      expect(sourceGlyph(preset.provider).glyph, preset.provider).not.toBe("@");
    }
    expect(sourceGlyph("ZOHOPRO").name).toBe("Zoho (organization)");
  });

  it("sends Account health's Reconnect link to the preset's own card", () => {
    for (const preset of IMAP_PRESETS) {
      expect(accountSectionId(preset.provider, "linked")).toBe(`account-${preset.slug}`);
    }
  });
});

describe("preset copy, all 7 locales", () => {
  const presetKeys = [
    ...IMAP_PRESETS.map((preset) => preset.hintKey),
    "imapPreset.passwordLabel.app",
    "onboardingV2.tile.preset.scope",
  ];

  it("asks every preset for an app password, never the account password", () => {
    const source = read("components/imap-preset-section.tsx");
    expect(source).toContain('label={t("imapPreset.passwordLabel.app")}');
    for (const [locale, table] of Object.entries(LOCALES)) {
      const keys = Object.keys(table);
      // Zoho has no label or tile line of its own any more: it is an app password too.
      expect(keys, locale).not.toContain("imapPreset.passwordLabel.zoho");
      expect(keys, locale).not.toContain("onboardingV2.tile.zoho.scope");
    }
    for (const key of ["imapPreset.hint.zoho", "imapPreset.hint.zohopro"]) {
      expect(en[key]).toContain("turn on two-factor authentication");
      expect(en[key]).toContain("application-specific password");
      expect(en[key]).not.toMatch(/\bIf two-factor\b|\botherwise\b/i);
    }
  });
  const shared = Object.keys(en).filter(
    (key) => key.startsWith("imapPreset.") || key.startsWith("imapGeneric."),
  );

  it("has a hint per preset and the shared card strings", () => {
    expect(new Set(IMAP_PRESETS.map((preset) => preset.hintKey)).size).toBe(IMAP_PRESETS.length);
    for (const key of [
      "imapPreset.body",
      "imapPreset.connect",
      "imapPreset.error.auth",
      "imapPreset.error.tooManyAttempts",
      "imapPreset.confirmDisconnect.title",
      "imapGeneric.title",
      "imapGeneric.body",
      "imapGeneric.authRefused",
      "onboardingV2.sheet.preset.title",
      "onboardingV2.sheet.preset.body",
    ]) {
      expect(Object.keys(en)).toContain(key);
    }
  });

  it("every locale has every key, non-empty, with each placeholder kept", () => {
    const keys = [
      ...new Set([
        ...presetKeys,
        ...shared,
        "onboardingV2.sheet.preset.title",
        "onboardingV2.sheet.preset.body",
      ]),
    ];
    for (const [locale, table] of Object.entries(LOCALES)) {
      for (const key of keys) {
        const value = (table as Record<string, string>)[key];
        expect(value, `${locale} ${key}`).toBeTruthy();
        for (const placeholder of en[key]?.match(/\{\w+\}/g) ?? []) {
          expect(value, `${locale} ${key}`).toContain(placeholder);
        }
      }
    }
  });

  it("is translated in Korean, not copied from English", () => {
    for (const key of [...presetKeys, ...shared]) {
      expect(ko[key], key).not.toBe(en[key]);
    }
  });
});

describe("classifyImapConnectFailure", () => {
  const apiError = (status: number, body: unknown) => `API ${status}: ${JSON.stringify(body)}`;

  it("names a refused login, which the user fixes with the hint", () => {
    expect(
      classifyImapConnectFailure(
        apiError(400, { ok: false, message: "Daum IMAP login failed.", code: "IMAP_AUTH_FAILED" }),
      ),
    ).toEqual({ kind: "auth" });
  });

  it("words an unreachable or unverifiable mailbox generically", () => {
    for (const code of ["IMAP_VERIFY_FAILED", "IMAP_UNREACHABLE"]) {
      expect(classifyImapConnectFailure(apiError(400, { ok: false, message: "x", code }))).toEqual({
        kind: "verify",
      });
    }
  });

  it("asks the user to wait after the connect rate limit", () => {
    expect(
      classifyImapConnectFailure(apiError(429, { statusCode: 429, message: "Rate limit" })),
    ).toEqual({ kind: "tooManyAttempts" });
  });

  it("shows the server's own sentence for a refusal it explains", () => {
    expect(
      classifyImapConnectFailure(
        apiError(400, { ok: false, message: "At most 10 Daum accounts." }),
      ),
    ).toEqual({ kind: "server", message: "At most 10 Daum accounts." });
    expect(classifyImapConnectFailure(apiError(409, { ok: false, message: "Changed." }))).toEqual({
      kind: "server",
      message: "Changed.",
    });
  });

  it("never shows raw response text: anything else is the generic failure", () => {
    expect(classifyImapConnectFailure("API 400: not json")).toEqual({ kind: "unexpected" });
    expect(classifyImapConnectFailure(apiError(404, { message: "Route not found" }))).toEqual({
      kind: "unexpected",
    });
    expect(classifyImapConnectFailure(apiError(500, { message: "boom" }))).toEqual({
      kind: "unexpected",
    });
    expect(classifyImapConnectFailure("Failed to fetch")).toEqual({ kind: "unexpected" });
  });
});

describe("generic IMAP card (display only)", () => {
  const entry = (provider: string, status = "ok") => ({
    id: `${provider}-1`,
    email: "me@example.com",
    provider: provider as never,
    kind: "linked" as const,
    status: status as never,
    lastSyncedAt: null,
    errorCode: null,
    errorAt: null,
    action: null,
  });

  it("lists only generic IMAP accounts", () => {
    const list = [entry("GOOGLE"), entry("IMAP"), entry("DAUM"), entry("IMAP", "reconnect")];
    expect(genericImapAccounts(list).map((account) => account.provider)).toEqual(["IMAP", "IMAP"]);
    expect(genericImapAccounts([entry("NAVER")])).toEqual([]);
  });

  it("never tells the user to reconnect what the web cannot reconnect", () => {
    expect(genericImapProblemKey(entry("IMAP", "reconnect"))).toBe("imapGeneric.authRefused");
    expect(genericImapProblemKey({ ...entry("IMAP", "ok"), errorCode: "auth" })).toBe(
      "imapGeneric.authRefused",
    );
    expect(genericImapProblemKey({ ...entry("IMAP", "error"), errorCode: "unreachable" })).toBe(
      "accountHealth.error.unreachable",
    );
    expect(genericImapProblemKey(entry("IMAP", "ok"))).toBeNull();
    // No Reconnect link from Account health: there is nothing on the web to land on.
    expect(accountSectionId("IMAP", "linked")).toBeNull();
  });

  it("has no form and never calls the generic IMAP routes", () => {
    const source = read("components/generic-imap-accounts-section.tsx");
    expect(source).not.toContain("/api/generic-imap");
    expect(source).not.toContain("<form");
    expect(source).not.toContain("<Button");
    expect(source).toContain("/api/email/accounts/health");
    expect(source).toContain('id="account-imap"');
  });
});

describe("preset card status probe", () => {
  const status = (accounts: number, canConnect = true): PresetStatus => ({
    canConnect,
    accounts: Array.from({ length: accounts }, (_, i) => ({
      email: `user${i}@example.com`,
      host: "imap.example.com:993",
      connectedAt: "2026-11-14T00:00:00Z",
      lastSyncedAt: null,
      needsReconnect: false,
    })),
  });
  const run = (...events: Parameters<typeof presetProbeReducer>[1][]): PresetProbe =>
    events.reduce(presetProbeReducer, INITIAL_PRESET_PROBE);

  it("draws nothing until /status has answered once", () => {
    expect(presetCardView(run(), true)).toBe("hidden");
    expect(presetCardView(run({ type: "start" }), true)).toBe("hidden");
  });

  it("draws nothing for a preset whose /status never succeeded (5xx, 429, offline)", () => {
    const probe = run({ type: "start" }, { type: "failed" });
    expect(probe.failed).toBe(true);
    expect(presetCardView(probe, true)).toBe("hidden");
  });

  it("draws nothing on a 404 (flag off or outside the cohort), even after a success", () => {
    expect(presetCardView(run({ type: "notFound" }), true)).toBe("hidden");
    const closed = run({ type: "loaded", status: status(1) }, { type: "notFound" });
    expect(presetCardView(closed, true)).toBe("hidden");
  });

  it("comes back when a later load succeeds after a 404", () => {
    const reopened = run(
      { type: "notFound" },
      { type: "start" },
      { type: "loaded", status: status(0) },
    );
    expect(reopened.unavailable).toBe(false);
    expect(presetCardView(reopened, true)).toBe("connect");
  });

  it("keeps the last good answer, flagged, when a refresh fails", () => {
    const probe = run({ type: "loaded", status: status(2) }, { type: "start" }, { type: "failed" });
    expect(probe.failed).toBe(true);
    expect(presetCardView(probe, true)).toBe("accounts");
    expect(run({ type: "loaded", status: status(2) }, { type: "start" }).loading).toBe(true);
  });

  it("offers the form, or the Pro note when a new mailbox is not allowed", () => {
    expect(presetCardView(run({ type: "loaded", status: status(0) }), true)).toBe("connect");
    expect(presetCardView(run({ type: "loaded", status: status(0, false) }), true)).toBe("proGate");
    // An answer without canConnect falls back to the plan.
    const legacy = run({ type: "loaded", status: { accounts: [] } });
    expect(presetCardView(legacy, false)).toBe("proGate");
  });

  it("lets only the newest request write, and nothing after unmount", () => {
    const guard = latestOnly();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    guard.dispose();
    expect(guard.isCurrent(second)).toBe(false);
  });

  it("guards each response and never reports the probe's failure as an error", () => {
    const source = read("components/imap-preset-section.tsx");
    expect(source).toContain("latestOnly()");
    expect(source).toContain("guard.isCurrent(token)");
    expect(source).not.toContain("-imap.status`");
    expect(source).toContain('if (view === "hidden") return null;');
  });
});

describe("preset card", () => {
  const source = read("components/imap-preset-section.tsx");

  it("probes its own status route and treats a 404 as not available", () => {
    expect(source).toContain("`/api/${preset.slug}-imap/status`");
    expect(source).toContain('startsWith("API 404")');
  });

  it("connects with an app password the browser never fills in from a saved one", () => {
    expect(source).toContain("`/api/${preset.slug}-imap/connect`");
    expect(source).toContain('autoComplete="new-password"');
    // Fixed host: the body carries the address and the password, never a host.
    expect(source).toContain("body: JSON.stringify({ email: email.trim(), password })");
  });

  it("disconnects one mailbox by its address and shows each mailbox's sync status", () => {
    expect(source).toContain("`/api/${preset.slug}-imap/disconnect`");
    expect(source).toContain("JSON.stringify({ email })");
    expect(source).toContain("<ImapAccountStatus");
  });

  it("appears in Settings -> Accounts once per preset, under the id Account health links to", () => {
    const page = read("app/settings/_sections/accounts-section.tsx");
    expect(page).toContain("IMAP_PRESETS.map(");
    expect(page).toContain("<ImapPresetSection preset={preset} />");
    expect(page).toContain('id={accountSectionId(preset.provider, "linked") ?? undefined}');
    expect(page).toContain("<GenericImapAccountsSection />");
  });
});
