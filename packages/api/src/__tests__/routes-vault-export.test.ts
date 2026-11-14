/**
 * Klorn Vault export route (routes/vault-export.ts), VAULT_EXPORT_ENABLED:
 *   - off: indistinguishable from a route that does not exist, even without a
 *     session; cohort: only ROLLOUT_COHORT_USER_IDS get through;
 *   - the zip holds the index, the five lane notes, sender notes, both
 *     commitment lists and one note per mail; mail text only on opt-in;
 *   - every query is scoped to the token's user (IDOR), whatever the query says;
 *   - one export per user per cooldown and one at a time, audited start to end;
 *   - nothing is written to disk or kept server-side.
 */

import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { zipTexts } from "./helpers/read-zip.js";

type Row = Record<string, unknown>;
interface Where {
  userId?: string;
  source?: string;
  sourceId?: { in: string[] };
  id?: { in: string[] };
  threadId?: { in: string[] };
  status?: { in: string[] };
  createdAt?: { gt: Date };
  outcome?: { not: string };
}
interface Args {
  where: Where;
  select?: Record<string, boolean>;
  take?: number;
  data?: Row;
}

const store = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; args: unknown }>,
  items: [] as Row[],
  mails: [] as Row[],
  labels: [] as Row[],
  briefs: [] as Row[],
  traits: [] as Row[],
  commitments: [] as Row[],
  audits: [] as Row[],
  gate: null as null | { model: string; reached: () => void; release: Promise<void> },
  failCommitments: false,
}));

function matches(row: Row, where: Where): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.source !== undefined && row.source !== where.source) return false;
  if (where.sourceId && !where.sourceId.in.includes(row.sourceId as string)) return false;
  if (where.id && !where.id.in.includes(row.id as string)) return false;
  if (where.threadId && !where.threadId.in.includes(row.threadId as string)) return false;
  if (where.status && !where.status.in.includes(row.status as string)) return false;
  if (where.createdAt && !((row.createdAt as Date) > where.createdAt.gt)) return false;
  if (where.outcome && row.outcome === where.outcome.not) return false;
  return true;
}

async function passGate(model: string): Promise<void> {
  if (store.gate?.model !== model) return;
  const { reached, release } = store.gate;
  store.gate = null;
  reached();
  await release;
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k]]),
  );
}

vi.mock("../db.js", () => {
  const table = (model: string, rows: () => Row[]) => ({
    findMany: vi.fn(async (args: Args) => {
      store.calls.push({ model, args });
      await passGate(model);
      if (model === "commitment" && store.failCommitments) throw new Error("db down");
      const found = rows().filter((r) => matches(r, args.where ?? {}));
      return found.slice(0, args.take ?? found.length).map((r) => pick(r, args.select));
    }),
  });
  const prisma = {
    attentionItem: table("attentionItem", () => store.items),
    emailMessage: table("emailMessage", () => store.mails),
    decisionLabel: table("decisionLabel", () => store.labels),
    threadBrief: table("threadBrief", () => store.briefs),
    senderTrait: table("senderTrait", () => store.traits),
    commitment: table("commitment", () => store.commitments),
    dataExportAudit: {
      create: vi.fn(async (args: Args) => {
        store.calls.push({ model: "dataExportAudit.create", args });
        const row = { id: `audit-${store.audits.length + 1}`, createdAt: new Date(), ...args.data };
        store.audits.push(row);
        return row;
      }),
      findFirst: vi.fn(async (args: Args) => {
        store.calls.push({ model: "dataExportAudit.findFirst", args });
        await passGate("dataExportAudit.findFirst");
        const found = store.audits.filter((r) => matches(r, args.where ?? {}));
        found.sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
        return found[0] ? pick(found[0], args.select) : null;
      }),
      updateMany: vi.fn(async (args: Args & { where: Where & { id: string } }) => {
        store.calls.push({ model: "dataExportAudit.updateMany", args });
        const row = store.audits.find(
          (r) => r.id === args.where.id && r.userId === args.where.userId,
        );
        if (row) Object.assign(row, args.data);
        return { count: row ? 1 : 0 };
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        email: "test@example.com",
        role: "USER",
        sessionsInvalidatedAt: null,
      })),
    },
    device: {
      findUnique: vi.fn(async () => ({
        id: "device-1",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
});
const limits = vi.hoisted(() => ({
  current: {} as Record<string, number>,
  defaults: {} as Record<string, number>,
}));
vi.mock("../vault/vault-limits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vault/vault-limits.js")>();
  limits.defaults = { ...actual.VAULT_LIMITS };
  Object.assign(limits.current, actual.VAULT_LIMITS);
  return { ...actual, VAULT_LIMITS: limits.current };
});
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const TOKEN = signToken({ userId: "user-1", email: "test@example.com" });
const URL_PATH = "/api/user/me/vault/export";

async function call(query = "", opts: { auth?: boolean } = {}) {
  const { vaultExportRoutes } = await import("../routes/vault-export.js");
  const app = Fastify();
  await app.register(vaultExportRoutes, { prefix: "/api/user/me/vault" });
  const res = await app.inject({
    method: "GET",
    url: `${URL_PATH}${query}`,
    headers: {
      ...(opts.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      "accept-language": "en",
    },
  });
  await app.close();
  return res;
}

/** Every wiki-link target in the archive that is not itself in the archive. */
function danglingLinks(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [name, text] of files) {
    for (const m of text.matchAll(/(?<!\\)\[\[([^\]|\\]+)(?:\\?\||\]\])/g)) {
      if (!files.has(`${m[1]}.md`)) out.push(`${name} -> ${m[1]}`);
    }
  }
  return out;
}

/** Holds the next query on `model` until released. */
function gateAt(model: string): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((resolve) => {
    reached = resolve;
  });
  store.gate = {
    model,
    reached,
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  return { reached: reachedP, release };
}

async function until(done: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function slotFree(): Promise<boolean> {
  const { acquireExportSlot } = await import("../vault/vault-audit.js");
  const slot = acquireExportSlot("user-1");
  if (typeof slot !== "object") return false;
  slot.release();
  return true;
}

/** A real server, so a test can drop or stall the client's socket. */
async function listening() {
  const { vaultExportRoutes } = await import("../routes/vault-export.js");
  const app = Fastify();
  await app.register(vaultExportRoutes, { prefix: "/api/user/me/vault" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    path: URL_PATH,
    headers: { authorization: `Bearer ${TOKEN}`, "accept-language": "en" },
  });
  req.on("error", () => undefined);
  req.end();
  return { app, req };
}

function seedUser(userId: string, tag: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const id = `${tag}000000-0000-4000-8000-00000000000${i}`;
    const received = new Date(Date.UTC(2026, 10, 12 - i, 1, 0, 0));
    store.mails.push({
      id,
      userId,
      gmailId: `${tag}-g${i}`,
      threadId: `${tag}-t${i}`,
      from: `Person ${i} <p${i}@${tag}corp.example>`,
      fromAddress: `p${i}@${tag}corp.example`,
      subject: `${tag.toUpperCase()} subject ${i}`,
      snippet: `${tag} snippet ${i}`,
      body: `${tag} secret body ${i}`,
      receivedAt: received,
    });
    store.items.push({
      id: `item-${tag}-${i}`,
      userId,
      source: "EMAIL",
      sourceId: id,
      tier: i === 0 ? "PUSH" : "AUTO",
      tierReason: `${tag} reason ${i}`,
      status: "OPEN",
      heldAt: null,
      isManualOverride: false,
      agentTierSetAt: null,
      v3PolicyVersion: null,
      v3Decision: null,
      v3Due: null,
      surfacedAt: received,
    });
    store.labels.push({
      userId,
      source: "EMAIL",
      sourceId: id,
      decidedBy: "llm",
      outcome: null,
      openedAt: received,
      repliedAt: i === 0 ? received : null,
      archivedAt: null,
      dismissedAt: null,
      snoozedAt: null,
      starredAt: null,
      unsubscribedAt: null,
      providerRepliedAt: null,
      providerArchivedAt: null,
    });
  }
  store.briefs.push({
    userId,
    threadId: `${tag}-t0`,
    whyNow: `${tag} why now`,
    asks: [`${tag} ask`],
    weOwe: null,
    theyOwe: null,
    stance: null,
  });
  store.traits.push({
    userId,
    sender: `p0@${tag}corp.example`,
    factKind: "relationship",
    factValue: "customer",
    confidence: 0.8,
    observedCount: 2,
    evidenceText: `${tag} evidence`,
    status: "active",
    lastSeenAt: new Date(),
  });
  // A stored value outside the allowed set is never exported.
  store.traits.push({
    userId,
    sender: `p1@${tag}corp.example`,
    factKind: "recurring_intent",
    factValue: "[[forged]]",
    confidence: 0.9,
    observedCount: 1,
    evidenceText: "x",
    status: "active",
    lastSeenAt: new Date(),
  });
  store.commitments.push({
    id: `c0ffee00-${tag}00-4000-8000-000000000000`,
    userId,
    title: `${tag} send the deck`,
    status: "OPEN",
    owner: "USER",
    counterpartyName: null,
    counterpartyEmail: `p0@${tag}corp.example`,
    dueAt: new Date("2026-11-15T00:00:00Z"),
    dueText: null,
    sourceType: "EMAIL",
    sourceId: `${tag}-g0`,
    threadId: `${tag}-t0`,
    confidence: 1,
    confirmedAt: null,
    completedAt: null,
    createdAt: new Date("2026-11-12T00:00:00Z"),
    updatedAt: new Date("2026-11-12T00:00:00Z"),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of [
    "calls",
    "items",
    "mails",
    "labels",
    "briefs",
    "traits",
    "commitments",
    "audits",
  ] as const) {
    store[key].length = 0;
  }
  store.gate = null;
  store.failCommitments = false;
  Object.assign(limits.current, limits.defaults);
  vi.stubEnv("VAULT_EXPORT_ENABLED", "true");
  vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "");
  seedUser("user-1", "a", 3);
  seedUser("user-2", "b", 2);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("flag", () => {
  it("off: the default 404, with or without a session, and no query runs", async () => {
    vi.stubEnv("VAULT_EXPORT_ENABLED", "");
    for (const auth of [true, false]) {
      const res = await call("", { auth });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        message: `Route GET:${URL_PATH} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }
    expect(store.calls).toEqual([]);
  });

  it("cohort: 404 outside the cohort, the export inside it", async () => {
    vi.stubEnv("VAULT_EXPORT_ENABLED", "cohort");
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "someone-else");
    expect((await call()).statusCode).toBe(404);
    expect(store.audits).toEqual([]);
    vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "someone-else,user-1");
    expect((await call()).statusCode).toBe(200);
  });

  it("needs a session when on", async () => {
    expect((await call("", { auth: false })).statusCode).toBe(401);
  });
});

describe("the archive", () => {
  it("streams a zip with the index, lanes, senders, commitments and one note per mail", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="klorn-vault-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    const files = zipTexts(res.rawPayload);
    const names = [...files.keys()].sort();
    expect(names).toEqual(
      [
        "Klorn/_klorn.md",
        "Klorn/commitments/active.md",
        "Klorn/commitments/done.md",
        "Klorn/lanes/INFO.md",
        "Klorn/lanes/MEETING.md",
        "Klorn/lanes/PUSH.md",
        "Klorn/lanes/QUEUE.md",
        "Klorn/lanes/SILENT.md",
        "Klorn/mail/2026/11/2026-11-10-a-subject-2-a0000000.md",
        "Klorn/mail/2026/11/2026-11-11-a-subject-1-a0000000.md",
        "Klorn/mail/2026/11/2026-11-12-a-subject-0-a0000000.md",
        "Klorn/senders/acorp.example.md",
      ].sort(),
    );
    const push = files.get("Klorn/mail/2026/11/2026-11-12-a-subject-0-a0000000.md") ?? "";
    expect(push).toContain('lane: "PUSH"');
    expect(push).toContain('lane_reason: "a reason 0"');
    expect(push).toContain("lane_reason_verified: false");
    expect(push).toContain('you: "replied"');
    expect(push).toContain('received: "2026-11-12T10:00:00+09:00"');
    expect(push).toContain("## Thread brief");
    expect(push).not.toContain("## Mail text");
    expect(push).not.toContain("secret body");
    // A retired v1 lane (AUTO) is read as QUEUE, never shown.
    expect(files.get("Klorn/lanes/QUEUE.md")).toContain("2 mails, newest first.");
    expect([...files.values()].join("\n")).not.toMatch(/\bAUTO\b/);
    const active = files.get("Klorn/commitments/active.md") ?? "";
    expect(active).toContain("a send the deck · you owe · due 2026-11-15");
    expect(active).toContain("[[Klorn/mail/2026/11/2026-11-12-a-subject-0-a0000000|A subject 0]]");
    const sender = files.get("Klorn/senders/acorp.example.md") ?? "";
    expect(sender).toContain("relationship: customer");
    expect(sender).not.toContain("forged");
    expect(files.get("Klorn/_klorn.md")).toContain("complete: true");
    expect(danglingLinks(files)).toEqual([]);
  });

  it("lists an unconfirmed suggestion apart from the commitments the user owns", async () => {
    store.commitments.push({
      ...(store.commitments[0] as Row),
      id: "c0ffee00-a100-4000-8000-000000000000",
      title: "a maybe follow up",
      confidence: 0.45,
      dueAt: null,
    });
    const active = zipTexts((await call()).rawPayload).get("Klorn/commitments/active.md") ?? "";
    const [owned, suggested] = active.split("## Suggested, not confirmed");
    expect(owned).toContain("- [ ] a send the deck");
    expect(owned).not.toContain("a maybe follow up");
    expect(suggested).toContain("- a maybe follow up · you owe");
  });

  it("pages through mails, putting a thread's brief on its newest note only", async () => {
    limits.current.pageSize = 1;
    const older = store.mails.find((m) => m.id === "a000000-0000-4000-8000-000000000001");
    if (older) older.threadId = "a-t0";
    const files = zipTexts((await call()).rawPayload);
    expect(files.get("Klorn/mail/2026/11/2026-11-12-a-subject-0-a0000000.md")).toContain(
      "## Thread brief",
    );
    expect(files.get("Klorn/mail/2026/11/2026-11-11-a-subject-1-a0000000.md")).not.toContain(
      "## Thread brief",
    );
    expect(store.calls.filter((c) => c.model === "emailMessage")).toHaveLength(3);
    expect(store.calls.filter((c) => c.model === "threadBrief")).toHaveLength(2);
  });

  it("leaves out a mail it cannot write, says so, and still exports the rest", async () => {
    const odd = store.mails.find((m) => m.id === "a000000-0000-4000-8000-000000000002");
    if (odd) odd.receivedAt = new Date("+010000-01-01T00:00:00Z");
    const files = zipTexts((await call()).rawPayload);
    expect([...files.keys()].filter((n) => n.startsWith("Klorn/mail/"))).toHaveLength(2);
    const index = files.get("Klorn/_klorn.md") ?? "";
    expect(index).toContain("- Mail: 1 could not be written and were left out.");
    expect(index).toContain("complete: false");
    expect(store.audits[0]?.outcome).toBe("partial");
  });

  it("selects no mail text unless asked, and includes it on bodies=1", async () => {
    await call();
    const mailSelects = store.calls
      .filter((c) => c.model === "emailMessage")
      .map((c) => (c.args as Args).select ?? {});
    expect(mailSelects.length).toBeGreaterThan(0);
    for (const select of mailSelects) {
      expect(select.htmlBody).toBeUndefined();
    }
    expect(mailSelects[0]?.body).toBeUndefined();

    store.audits.length = 0;
    const res = await call("?bodies=1");
    expect(res.statusCode).toBe(200);
    const note =
      zipTexts(res.rawPayload).get("Klorn/mail/2026/11/2026-11-12-a-subject-0-a0000000.md") ?? "";
    expect(note).toContain("## Mail text\n\n```text\na secret body 0\n```");
    expect(store.audits.at(-1)?.includeBodies).toBe(true);
  });

  it("refuses an unknown bodies value", async () => {
    expect((await call("?bodies=yes")).statusCode).toBe(400);
  });
});

describe("data scope (IDOR)", () => {
  it("exports only the token's user, whatever the query names", async () => {
    const res = await call("?userId=user-2&user=user-2");
    expect(res.statusCode).toBe(200);
    const all = [...zipTexts(res.rawPayload).values()].join("\n");
    expect(all).toContain("A subject 0");
    expect(all).not.toMatch(/B subject|b reason|b why now|b send the deck|bcorp|b evidence/);
    expect(store.calls.length).toBeGreaterThan(5);
    for (const { model, args } of store.calls) {
      const scope = (args as Args).where ?? (args as Args).data ?? {};
      expect(scope.userId, model).toBe("user-1");
    }
  });
});

describe("limits", () => {
  it("allows one export per user per cooldown, and says when to retry", async () => {
    expect((await call()).statusCode).toBe(200);
    const again = await call();
    expect(again.statusCode).toBe(429);
    const body = again.json() as { code: string; retryAfterSeconds: number };
    expect(body.code).toBe("rate-limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(9 * 60);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(10 * 60);
    expect(store.audits).toHaveLength(1);

    const first = store.audits[0];
    if (first) first.createdAt = new Date(Date.now() - 11 * 60_000);
    expect((await call()).statusCode).toBe(200);
  });

  it("refuses a second export while the first is still streaming", async () => {
    let reached!: () => void;
    const atQuery = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    store.gate = {
      model: "attentionItem",
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const first = call();
    await atQuery;
    const second = await call();
    expect(second.statusCode).toBe(429);
    expect((second.json() as { code: string }).code).toBe("export-in-progress");
    release();
    expect((await first).statusCode).toBe(200);
    expect(store.audits).toHaveLength(1);
  });

  it("audits each export from start to end, without content", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(store.audits).toHaveLength(1);
    const audit = store.audits[0] ?? {};
    expect(audit).toMatchObject({
      userId: "user-1",
      format: "vault-markdown",
      includeBodies: false,
      outcome: "ok",
      noteCount: 12,
      byteCount: res.rawPayload.length,
    });
    expect(audit.finishedAt).toBeInstanceOf(Date);
    expect(store.calls.filter((c) => c.model === "dataExportAudit.updateMany")).toHaveLength(1);
    const written = store.calls
      .filter((c) => c.model.startsWith("dataExportAudit.") && (c.args as Args).data)
      .flatMap((c) => Object.keys((c.args as Args).data ?? {}));
    expect(new Set(written)).toEqual(
      new Set([
        "userId",
        "format",
        "includeBodies",
        "outcome",
        "noteCount",
        "byteCount",
        "finishedAt",
      ]),
    );
  });

  it("records a failure and frees the user's slot", async () => {
    store.failCommitments = true;
    await call().catch(() => undefined);
    expect(store.audits[0]?.outcome).toBe("error");
    const { acquireExportSlot } = await import("../vault/vault-audit.js");
    const slot = acquireExportSlot("user-1");
    expect(typeof slot).toBe("object");
    if (typeof slot === "object") slot.release();
    // The server's failure does not cost the user the cooldown.
    store.failCommitments = false;
    expect((await call()).statusCode).toBe(200);
  });
});

describe("size and time bounds", () => {
  const mailNotes = (files: Map<string, string>) =>
    [...files.keys()].filter((n) => n.startsWith("Klorn/mail/"));

  it("keeps the newest mails up to the count limit and says the export is partial", async () => {
    limits.current.maxMailNotes = 2;
    const res = await call();
    const files = zipTexts(res.rawPayload);
    expect(mailNotes(files).sort()).toEqual([
      "Klorn/mail/2026/11/2026-11-11-a-subject-1-a0000000.md",
      "Klorn/mail/2026/11/2026-11-12-a-subject-0-a0000000.md",
    ]);
    const index = files.get("Klorn/_klorn.md") ?? "";
    expect(index).toContain("complete: false");
    expect(index).toContain("it reached the most mails one export holds");
    expect(store.audits[0]?.outcome).toBe("partial");
    const pick = store.calls.find((c) => c.model === "attentionItem")?.args as Args & {
      orderBy: unknown;
    };
    expect(pick.orderBy).toEqual([{ surfacedAt: "desc" }, { id: "desc" }]);
    expect(pick.take).toBe(3);
    expect(danglingLinks(files)).toEqual([]);
  });

  it("stops adding mail notes at the size limit, and still closes a valid archive", async () => {
    limits.current.maxMailBytes = 1;
    const res = await call("?bodies=1");
    const files = zipTexts(res.rawPayload);
    expect(mailNotes(files)).toEqual([]);
    expect(files.get("Klorn/_klorn.md")).toContain("it reached the size one export can be");
    expect(files.has("Klorn/commitments/active.md")).toBe(true);
    // The commitment's mail note was never written: no link to it.
    expect(files.get("Klorn/commitments/active.md")).not.toContain("[[Klorn/mail/");
    expect(danglingLinks(files)).toEqual([]);
  });

  it("stops adding mail notes at the time limit", async () => {
    limits.current.timeBudgetMs = -1;
    const files = zipTexts((await call()).rawPayload);
    expect(mailNotes(files)).toEqual([]);
    expect(files.get("Klorn/_klorn.md")).toContain("it reached the time one export can take");
  });

  it("caps each body and the whole archive", async () => {
    for (const mail of store.mails) mail.body = "x".repeat(200_000);
    limits.current.maxBodyChars = 1_000;
    const res = await call("?bodies=1");
    const note =
      zipTexts(res.rawPayload).get("Klorn/mail/2026/11/2026-11-12-a-subject-0-a0000000.md") ?? "";
    expect(note).toContain(`${"x".repeat(1_000)}\n…`);
    expect(note).not.toContain("x".repeat(1_001));
  });

  it("has defaults that bound the archive well inside the ZIP format", async () => {
    const { VAULT_LIMITS, worstCaseArchiveBytes } = await import("../vault/vault-limits.js");
    const { ZIP_MAX_ENTRIES } = await import("../vault/zip-writer.js");
    expect(limits.defaults.maxMailNotes).toBeLessThanOrEqual(5_000);
    expect(worstCaseArchiveBytes(VAULT_LIMITS)).toBeLessThan(256 * 1024 * 1024);
    expect(VAULT_LIMITS.maxMailNotes + VAULT_LIMITS.maxSenderTraits + 10).toBeLessThan(
      ZIP_MAX_ENTRIES,
    );
  });
});

describe("partial lists", () => {
  it("says when commitments or sender traits reached their limit", async () => {
    limits.current.maxCommitments = 0;
    limits.current.maxSenderTraits = 0;
    const index = zipTexts((await call()).rawPayload).get("Klorn/_klorn.md") ?? "";
    expect(index).toContain("- Commitments: a list reached the most one export holds");
    expect(index).toContain("- Senders: some of what Klorn learned about senders was left out.");
    expect(store.audits[0]?.outcome).toBe("partial");
  });
});

describe("client goes away", () => {
  it("frees the slot when the client leaves before the stream starts", async () => {
    const gate = gateAt("dataExportAudit.findFirst");
    const { app, req } = await listening();
    try {
      await gate.reached;
      req.destroy();
      // Freed while the request still waits on its first query.
      await until(slotFree);
      expect(store.audits).toEqual([]);
      gate.release();
      await until(() => store.audits.length === 1 && store.audits[0]?.outcome !== "started");
      expect(store.audits[0]?.outcome).toBe("aborted");
    } finally {
      gate.release();
      await app.close();
    }
  });

  it("frees the slot and audits once when the client leaves mid-stream", async () => {
    const gate = gateAt("attentionItem");
    const { app, req } = await listening();
    try {
      await gate.reached;
      req.destroy();
      await until(() => store.audits[0]?.outcome === "aborted");
      await until(slotFree);
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(store.calls.filter((c) => c.model === "dataExportAudit.updateMany")).toHaveLength(1);
    } finally {
      gate.release();
      await app.close();
    }
  });

  it("closes a request that outlives the wall-clock cap, freeing the slot", async () => {
    limits.current.streamMaxMs = 150;
    const gate = gateAt("attentionItem");
    const { app, req } = await listening();
    let clientClosed = false;
    req.on("close", () => {
      clientClosed = true;
    });
    try {
      await gate.reached;
      await until(() => store.audits[0]?.outcome === "aborted", 3_000);
      await until(slotFree, 3_000);
      await until(() => clientClosed, 3_000);
    } finally {
      gate.release();
      await app.close();
    }
  });
});

describe("no server-side residue", () => {
  it("writes nothing to the temp directory", async () => {
    const before = readdirSync(tmpdir()).sort();
    expect((await call("?bodies=1")).statusCode).toBe(200);
    const created = readdirSync(tmpdir()).filter((f) => !before.includes(f));
    expect(created.filter((f) => /vault|klorn|\.zip$/i.test(f))).toEqual([]);
  });

  it("the export code never touches the file system", () => {
    const files = [
      "../vault/vault-export.ts",
      "../vault/vault-export-lists.ts",
      "../vault/vault-export-state.ts",
      "../vault/vault-limits.ts",
      "../vault/vault-mail-rows.ts",
      "../vault/vault-audit.ts",
      "../vault/zip-writer.ts",
      "../vault/vault-notes.ts",
      "../vault/vault-index-notes.ts",
      "../vault/vault-paths.ts",
      "../vault/vault-escape.ts",
      "../routes/vault-export.ts",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(
        /from "(node:)?(fs|fs\/promises|os)"|tmpdir|createWriteStream|writeFile/,
      );
    }
  });
});
