/**
 * Settings → Integrations → Slack (web): the panel's pure helpers, and every
 * `slack.*` key the panel uses exists in all three locales with its
 * placeholders intact.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseChannelIds,
  slackFailure,
  slackPanelVisible,
  slackWorkspaceHost,
} from "../../../web/src/app/settings/_sections/slack-settings";
import en from "../../../web/src/lib/locales/en";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

const LOCALES: Record<string, Record<string, string>> = { en, ko, zh };

describe("slackPanelVisible", () => {
  it("is true only when /me says Slack is open to this user", () => {
    expect(slackPanelVisible({ slack: true })).toBe(true);
    expect(slackPanelVisible({ slack: false })).toBe(false);
    expect(slackPanelVisible({})).toBe(false);
    expect(slackPanelVisible(null)).toBe(false);
  });
});

describe("parseChannelIds", () => {
  it("splits on commas, spaces and new lines and drops duplicates", () => {
    expect(parseChannelIds(" C0123456789, G0123456789\nC0123456789 ")).toEqual([
      "C0123456789",
      "G0123456789",
    ]);
    expect(parseChannelIds("   ")).toEqual([]);
  });
});

describe("slackFailure", () => {
  it("maps a known API error code, with the scopes for scope errors", () => {
    const err = new Error('API 400: {"error":"x","code":"extra-scopes","scopes":["chat:write"]}');
    expect(slackFailure(err)).toEqual({
      key: "slack.error.extra-scopes",
      vars: { scopes: "chat:write" },
    });
    expect(slackFailure(new Error('API 409: {"code":"not-started"}'))).toEqual({
      key: "slack.error.not-started",
    });
  });

  it("falls back to the generic message for anything else", () => {
    expect(slackFailure(new Error('API 400: {"code":"__proto__"}'))).toEqual({
      key: "slack.error.generic",
    });
    expect(slackFailure(new Error("network down"))).toEqual({ key: "slack.error.generic" });
    expect(slackFailure("nope")).toEqual({ key: "slack.error.generic" });
  });
});

describe("slackWorkspaceHost", () => {
  it("shows the workspace host", () => {
    expect(slackWorkspaceHost("https://acme.slack.com/")).toBe("acme.slack.com");
    expect(slackWorkspaceHost(null)).toBeNull();
    expect(slackWorkspaceHost("not a url")).toBeNull();
  });
});

describe("Slack panel copy", () => {
  const panel = readFileSync(
    new URL("../../../web/src/app/settings/_sections/slack-panel.tsx", import.meta.url),
    "utf8",
  );
  const helpers = readFileSync(
    new URL("../../../web/src/app/settings/_sections/slack-settings.ts", import.meta.url),
    "utf8",
  );
  const used = [...panel.matchAll(/t\("(slack\.[a-zA-Z.-]+)"/g)].map((m) => m[1] as string);
  const codes = [...helpers.matchAll(/^ {2}"([a-z-]+)",$/gm)].map((m) => `slack.error.${m[1]}`);
  const keys = [...new Set([...used, ...codes, "slack.error.generic"])];

  it("uses keys that exist in every locale, placeholders intact", () => {
    expect(keys.length).toBeGreaterThan(20);
    for (const [locale, table] of Object.entries(LOCALES)) {
      for (const key of keys) {
        const value = table[key];
        expect(value, `${locale} ${key}`).toBeTruthy();
        const placeholders = (en[key] ?? "").match(/\{[a-z]+\}/g) ?? [];
        for (const placeholder of placeholders)
          expect(value, `${locale} ${key}`).toContain(placeholder);
      }
    }
  });
});
