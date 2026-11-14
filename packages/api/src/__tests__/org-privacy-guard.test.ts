/**
 * Klorn Teams privacy invariants, enforced on the source (the real-Postgres
 * proof is org-privacy-invariants-pg.test.ts). The organization code — every
 * file under src/org/ and routes/orgs.ts — may touch only the org tables, the
 * account row and the calendar's start/end times. It never queries mail,
 * attention items, commitments, drafts, dossiers or any other member data,
 * never runs raw SQL, and never pulls a relation in wholesale with `include`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NEVER_VISIBLE_TO_ORG, VISIBLE_TO_ORG } from "../org/privacy.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

const ALLOWED_MODELS = new Set([
  "organization",
  "orgMembership",
  "orgInvite",
  "availabilityGrant",
  "orgAuditEvent",
  "user",
  "calendarEvent",
  "$transaction",
]);

function orgSources(): Array<{ path: string; text: string }> {
  const orgDir = join(srcDir, "org");
  const files = readdirSync(orgDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(orgDir, name));
  return [...files, join(srcDir, "routes", "orgs.ts")].map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
}

describe("org code reaches no member data", () => {
  const sources = orgSources();

  it("finds the org sources", () => {
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });

  it("queries only the org tables, the account row and calendar times", () => {
    const touched = new Set<string>();
    for (const { text } of sources) {
      for (const [, model] of text.matchAll(/(?<![/\w.])(?:prisma|tx|db|client)\.(\$?\w+)\b/g)) {
        touched.add(model ?? "");
      }
    }
    const forbidden = [...touched].filter((model) => !ALLOWED_MODELS.has(model));
    expect(forbidden).toEqual([]);
  });

  it("runs no raw SQL and includes no relation wholesale", () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/\$queryRaw|\$executeRaw|\$queryRawUnsafe/);
      expect(text, path).not.toMatch(/\binclude\s*:/);
    }
  });

  it("selects only start and end times (and the owner) from a calendar event", () => {
    const selects: string[] = [];
    for (const { text } of sources) {
      for (const [, body] of text.matchAll(
        /calendarEvent\.findMany\(\{[\s\S]*?select:\s*\{([^}]*)\}/g,
      )) {
        selects.push(body ?? "");
      }
    }
    expect(selects.length).toBeGreaterThan(0);
    for (const body of selects) {
      const keys = [...body.matchAll(/(\w+)\s*:/g)].map(([, key]) => key);
      expect(keys.sort()).toEqual(["endTime", "startTime", "userId"]);
    }
  });

  it("reads only identity fields from an account row", () => {
    const reads: string[] = [];
    for (const { text } of sources) {
      for (const [, body] of text.matchAll(
        /(?<![/\w.])(?:prisma|tx)\.user\.\w+\(\{[\s\S]*?select:\s*\{([^}]*)\}/g,
      )) {
        reads.push(body ?? "");
      }
    }
    expect(reads.length).toBeGreaterThan(0);
    for (const body of reads) {
      const keys = [...body.matchAll(/(\w+)\s*:/g)].map(([, key]) => key ?? "");
      expect(keys.filter((key) => !["id", "name", "email", "emailVerified"].includes(key))).toEqual(
        [],
      );
    }
  });

  it("reads only name and email from another account", () => {
    for (const { path, text } of sources) {
      for (const [, body] of text.matchAll(/\buser:\s*\{\s*select:\s*\{([^}]*)\}/g)) {
        const keys = [...(body ?? "").matchAll(/(\w+)\s*:/g)].map(([, key]) => key ?? "");
        const extra = keys.filter((key) => !["id", "name", "email"].includes(key));
        expect(extra, path).toEqual([]);
      }
    }
  });
});

describe("member transparency (static truth)", () => {
  it("lists mail, attention items and commitments as never visible to the org", () => {
    expect(NEVER_VISIBLE_TO_ORG).toEqual(
      expect.arrayContaining([
        "mail",
        "attentionItems",
        "commitments",
        "drafts",
        "dossiers",
        "eventDetails",
        "chat",
      ]),
    );
  });

  it("shows the org seats, roles and cost, and free/busy only under the member's grant", () => {
    expect(VISIBLE_TO_ORG.map((entry) => entry.key)).toEqual([
      "roles",
      "seats",
      "cost",
      "freeBusy",
      "auditLog",
    ]);
    const visible = new Set(VISIBLE_TO_ORG.map((entry) => entry.key));
    for (const key of NEVER_VISIBLE_TO_ORG) expect(visible.has(key)).toBe(false);
  });
});
