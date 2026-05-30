/**
 * Read-path invariant — the classifier (poc-judge) MUST NOT be called from
 * any read route. Classification happens at sync-time and the firewall
 * read path renders cached AttentionItem rows; the moment a read path
 * starts re-invoking the scorer, sender-trust signals on already-classified
 * emails get silently re-stamped on every page load, breaking the
 * deterministic Day-7 GATE measurement and inflating LLM costs.
 *
 * The pattern (throw on invoke + assert read paths still succeed) was
 * committed to publicly on dev.to (2026-05-28 reply, Article A):
 *
 *   > Stealing the throw-on-invoke mock pattern wholesale for the v1
 *   > hardening pass.
 *
 * Two complementary checks:
 *   1. Module-load mock — importing routes/firewall.js must not trigger
 *      the classifier at any top-level expression. The mock throws on
 *      call so a regression fails loudly here instead of silently
 *      re-classifying on every request.
 *   2. Source-level grep — none of the three read route files may
 *      import poc-judge or call judgeEmail in code (comments are fine).
 *      Catches regressions where a handler is wired up but the test
 *      below didn't load that specific module.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Throw-on-invoke — any read path that touches the classifier at
// module-load time fails this test immediately with the explicit
// "invariant violated" message.
const judgeEmailMock = vi.fn(() => {
  throw new Error("invariant violated: read path invoked poc-judge classifier");
});
const judgeEmailsMock = vi.fn(() => {
  throw new Error("invariant violated: read path invoked poc-judge classifier (bulk)");
});

vi.mock("../poc-judge.js", () => ({
  judgeEmail: judgeEmailMock,
  judgeEmails: judgeEmailsMock,
  POC_TIERS: ["SILENT", "QUEUE", "PUSH", "AUTO"],
  tierFromFeatures: vi.fn(() => ({ tier: "QUEUE", reason: "stub" })),
}));

// Importing the firewall route triggers any top-level / module-init code
// it has. The mocks above ensure a regression fires synchronously.
import "../routes/firewall.js";

const READ_PATH_SOURCES = [
  "../routes/firewall.ts", // GET /api/inbox/firewall
  "../routes/email.ts", // GET /api/email/:id
  "../routes/inbox.ts", // GET /api/inbox
];

describe("classifier read-path invariant", () => {
  it("importing the firewall route does not invoke the classifier", () => {
    expect(judgeEmailMock).not.toHaveBeenCalled();
    expect(judgeEmailsMock).not.toHaveBeenCalled();
  });

  for (const rel of READ_PATH_SOURCES) {
    it(`${rel} must not import or call poc-judge`, () => {
      const src = readFileSync(join(__dirname, rel), "utf-8");
      // Strip line + block comments — references inside docs are fine.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");

      expect(stripped, `${rel} must not import from poc-judge`).not.toMatch(
        /from\s+["']\.{1,2}\/poc-judge/,
      );
      expect(stripped, `${rel} must not call judgeEmail()`).not.toMatch(/\bjudgeEmail\s*\(/);
      expect(stripped, `${rel} must not call judgeEmails()`).not.toMatch(/\bjudgeEmails\s*\(/);
    });
  }
});
