/**
 * Every server-side AI provider must be disclosed before it can see user mail.
 *
 * Klorn reads Gmail under Google's Limited Use rules and passed CASA on the
 * strength of a privacy policy and DPA that name the AI sub-processors. A new
 * env provider (e.g. Anthropic, 2026-10) that ships without being added there
 * would send mail to an undisclosed processor the moment its key is set.
 *
 * `satisfies Record<EnvProviderName, …>` makes adding a provider to the
 * registry a type error here until its disclosure name is recorded; the file
 * checks then fail until the policy pages actually say it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EnvProviderName } from "../providers/index.js";

const DISCLOSED_AS = {
  openrouter: "OpenRouter",
  gemini: "Gemini",
  anthropic: "Anthropic",
} as const satisfies Record<EnvProviderName, string>;

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), "utf8");

const PAGES = {
  "privacy policy": "packages/web/src/app/privacy/page.tsx",
  "DPA subprocessor table": "website/dpa/index.html",
} as const;

describe("AI sub-processor disclosure", () => {
  for (const [page, rel] of Object.entries(PAGES)) {
    it.each(Object.entries(DISCLOSED_AS))(`the ${page} names %s`, (_provider, name) => {
      expect(repoFile(rel)).toContain(name);
    });
  }
});
