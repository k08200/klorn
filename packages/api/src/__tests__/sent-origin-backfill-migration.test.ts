/**
 * Legacy SentMessage provenance (2026-11-01). #1591 added `SentMessage.origin`
 * with no backfill, so every row recorded before it is null, and null reads as
 * "the user wrote it" to the attention engine's relationship snapshot
 * (docs/design/attention-engine-v3.md §3(2)). This migration labels the legacy
 * rows Klorn can PROVE it sent, and nothing else. The SQL is the contract for
 * what production rows may look like, so its text is pinned here; the CI
 * Migrations job proves it applies against schema.prisma.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261101000000_sent_message_origin_backfill";
const sql = readFileSync(
  join(here, "..", "..", "prisma", "migrations", MIGRATION, "migration.sql"),
  "utf8",
);
const flat = (text: string) =>
  text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
const code = flat(
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n"),
);
const statements = code
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const updates = statements.filter((s) => /\bUPDATE "SentMessage"/.test(s));

describe("legacy sent provenance backfill — what it may write", () => {
  it("fails fast when a lock is held: lock_timeout is the first statement", () => {
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s'`);
  });

  it("is data-only: no DDL", () => {
    expect(code).not.toMatch(/\b(ALTER|CREATE|DROP|TRUNCATE)\b/i);
  });

  it("never deletes and never touches another table", () => {
    expect(code).not.toMatch(/\bDELETE\b/i);
    const written = [...code.matchAll(/\bUPDATE\s+"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(new Set(written)).toEqual(new Set(["SentMessage"]));
  });

  it("writes exactly three labels, each once: approved, auto_reply, unsubscribe", () => {
    const labels = updates.map((s) => s.match(/SET "origin" = '([a-z_]+)'/)?.[1]);
    expect(labels).toEqual(["approved", "auto_reply", "unsubscribe"]);
  });

  it("never writes 'user': a legacy row has no proof of a manual send, and null already counts as the user's", () => {
    expect(code).not.toContain(`'user'`);
  });

  it("only fills nulls, so a label recorded at send time is never overwritten and a re-run is a no-op", () => {
    for (const s of updates) expect(s).toContain(`s."origin" IS NULL`);
  });

  it("scopes every match to the row's own user", () => {
    for (const s of updates) expect(s).toMatch(/"userId" = s\."userId"/);
  });
});

describe("approved — the provider message id an executed approval returned", () => {
  const s = () => updates[0] ?? "";

  it("matches the gmailId exactly against a COMPLETED outbox send or an EXECUTED pending send", () => {
    expect(s()).toContain(
      `o."toolName" = 'send_email' AND o."status" = 'COMPLETED' AND substring(o."result" from '"messageId":"([^"]+)"') = s."gmailId"`,
    );
    expect(s()).toContain(
      `p."toolName" = 'send_email' AND p."status" = 'EXECUTED' AND substring(p."result" from '"messageId":"([^"]+)"') = s."gmailId"`,
    );
  });
});

describe("auto_reply — the claim the unattended reply wrote before sending", () => {
  const s = () => updates[1] ?? "";

  it("reads the claim rows: auto-reply:, the older auto-mode-reply:, and the pre-dedupeKey 'Auto-reply sent'", () => {
    expect(s()).toContain(
      `(n."dedupeKey" LIKE 'auto-reply:%' OR n."dedupeKey" LIKE 'auto-mode-reply:%' OR (n."dedupeKey" IS NULL AND n."title" = 'Auto-reply sent'))`,
    );
  });

  it("joins the mail it answered by the claim's gmail id", () => {
    expect(s()).toContain(
      `e."gmailId" = COALESCE(substring(n."dedupeKey" from '^(?:auto-reply|auto-mode-reply):(.+)$'), substring(n."message" from '\\[([^\\]]+)\\]\\s*$'))`,
    );
  });

  it("requires the claim's recipient, the exact 'Re: <subject>' both senders use, and a send right after the claim", () => {
    expect(s()).toContain(
      `lower(btrim(s."to")) = lower(substring(n."message" from '(?:replied|reply) to (\\S+)'))`,
    );
    expect(s()).toContain(`s."subject" = 'Re: ' || e."subject"`);
    expect(s()).toContain(
      `s."sentAt" BETWEEN n."createdAt" - interval '1 minute' AND n."createdAt" + interval '2 minutes'`,
    );
  });

  it("skips claims rewritten as failed: nothing left, so a manual reply right after must stay the user's", () => {
    expect(s()).toContain(`n."title" NOT IN ('Auto-reply failed', 'Auto-mode reply failed')`);
  });
});

describe("unsubscribe — a mailto List-Unsubscribe target the user received", () => {
  const s = () => updates[2] ?? "";

  it("derives the target address and subject the way parseMailtoTarget does (subject defaults to 'unsubscribe')", () => {
    expect(s()).toContain(
      `lower(btrim(split_part(regexp_replace("listUnsubscribeMailto", '^mailto:', '', 'i'), '?', 1))) AS addr`,
    );
    expect(s()).toContain(`WITH targets AS MATERIALIZED (`);
    expect(s()).toContain(
      `COALESCE(NULLIF(btrim(replace(substring("listUnsubscribeMailto" from '[?&]subject=([^&]*)'), '+', ' ')), ''), 'unsubscribe') AS subject`,
    );
  });

  it("requires the row's single recipient to BE that address", () => {
    expect(s()).toContain(`t.addr <> '' AND t.addr = lower(btrim(s."to"))`);
  });

  it("when the address also sends the user mail (it may be a person), demands the exact mailto subject too", () => {
    expect(s()).toContain(
      `(t.subject = s."subject" OR NOT EXISTS (SELECT 1 FROM "EmailMessage" e WHERE e."userId" = s."userId" AND (e."fromAddress" = t.addr OR position(t.addr in lower(e."from")) > 0)))`,
    );
  });
});
