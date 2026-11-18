/**
 * Personal Pro plus a Klorn Teams seat (pricing-tiers.md, "Personal Pro and a
 * team seat"): Klorn never cancels the personal subscription itself, so the
 * billing surface must say that the seat already covers Pro, next to the
 * personal cancel. Static check of packages/web: the status payload's flag is
 * carried into the subscription state, the manager renders the notice from
 * it, and every locale has the copy.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webSrc = join(dirname(fileURLToPath(import.meta.url)), "../../../web/src");
const read = (path: string) => readFileSync(join(webSrc, path), "utf8");
const KEY = "billing.teamSeatCoversPro";

describe("a team seat that already covers Pro is said, not acted on", () => {
  it("carries the API flag into the subscription state", () => {
    const text = read("lib/subscription.ts");
    expect(text).toMatch(/teamSeatCoversPersonalPlan\?: boolean;/);
    expect(text).toMatch(
      /teamSeatCoversPersonalPlan:\s*status\.teamSeatCoversPersonalPlan\s*===\s*true/,
    );
  });

  it("renders the notice from that flag in the subscription manager", () => {
    const text = read("components/subscription-manager.tsx");
    expect(text).toContain(`t("${KEY}")`);
    expect(text).toMatch(/state\.teamSeatCoversPersonalPlan/);
  });

  it("has the copy in every locale, never promising an automatic cancel", () => {
    const dir = join(webSrc, "lib/locales");
    const locales = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(locales.length).toBe(3);
    for (const name of locales) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).toContain(`"${KEY}"`);
    }
    const en = readFileSync(join(dir, "en.ts"), "utf8");
    const copy = new RegExp(`"${KEY.replace(".", "\\.")}":\\s*"([^"]*)"`).exec(en)?.[1] ?? "";
    expect(copy).toMatch(/team seat/i);
    expect(copy).not.toMatch(/automatic|we('| wi)ll cancel/i);
  });
});
