/**
 * create_draft through the real MCP server (step A4): ListTools and CallTool as
 * a client sees them. The shared tool registry and executor are faked (as in
 * mcp-set-tier-server.test.ts) so every read result is a known byte string, but
 * the plan gate is REAL (the real feature map decides who may draft). The gate,
 * the write call, the audit row, the per-user cap and create_draft itself are real;
 * only the provider seam is a spy.
 */

import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const executeToolCall = vi.hoisted(() => vi.fn());
const mailActionsFor = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn());
const createDraft = vi.hoisted(() => vi.fn());
const getReplyHeaders = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/providers/dispatch.js", () => ({ mailActionsFor }));
vi.mock("../agentcore/chat-engine.js", () => ({
  CHAT_TOOL_NAMES: new Set(["list_emails", "read_email"]),
}));
vi.mock("../agentcore/tool-executor.js", async () => {
  const { planHasFeature, TOOL_FEATURE_MAP } = await import("../billing/stripe.js");
  return {
    ALL_TOOLS: ["list_emails", "read_email", "mark_read"].map((name) => ({
      type: "function",
      function: {
        name,
        description: `${name} desc`,
        parameters: { type: "object", properties: {} },
      },
    })),
    executeToolCall,
    // The real rule, over the real map: a tool with no entry is open, else the plan must have the feature.
    isToolAllowedForPlan: (name: string, plan: string) => {
      const feature = TOOL_FEATURE_MAP[name];
      return !feature || planHasFeature(plan, feature);
    },
  };
});

import { buildMcpServer } from "../mcp/server.js";
import { hashToolArgs } from "../mcp/write-audit.js";
import { MCP_CREATE_DRAFT_CAP_PER_WINDOW, MCP_WRITE_CAP_PER_WINDOW } from "../mcp/write-call.js";

const LIST_RAW = JSON.stringify([{ id: "18c3f0a1b2c3d4e5", from: "a@b.co", subject: "Hi" }]);
const EMAIL_ID = "18c3f0a1b2c3d4e5";
const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const BODY = "Thursday works. See you then.";

let db: FakeDb;
let seq = 0;
let user: string;
let key: string;

/** A fresh user and key per test: the write cap and the refused-audit throttle live in module state by design. */
async function connect(permission: "read" | "read_write", plan = "PRO", keyId = key) {
  const server = buildMcpServer(user, plan, { keyId, permission });
  const client = new Client({ name: "t", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
const textOf = (result: { content?: unknown }) =>
  (result.content as Array<{ text: string }>)[0].text;
const draftCall = (client: Client, args: Record<string, unknown> = {}) =>
  client.callTool({
    name: "create_draft",
    arguments: { email_id: EMAIL_ID, body: BODY, ...args },
  });

beforeEach(() => {
  seq += 1;
  user = `draft-user-${seq}`;
  key = `draft-key-${seq}`;
  executeToolCall.mockReset();
  executeToolCall.mockResolvedValue(LIST_RAW);
  sendEmail.mockReset();
  createDraft.mockReset();
  createDraft.mockResolvedValue({ success: true, draftId: "draft-7", url: "u" });
  getReplyHeaders.mockReset();
  getReplyHeaders.mockResolvedValue({ messageId: "<orig@mail.example>" });
  mailActionsFor.mockReset();
  mailActionsFor.mockResolvedValue({ provider: "GOOGLE", sendEmail, createDraft, getReplyHeaders });
  db = createFakeDb({
    emailMessage: [
      {
        id: "email-db-1",
        userId: user,
        gmailId: EMAIL_ID,
        threadId: "thread-1",
        from: "Alice <alice@example.com>",
        subject: "Plan",
        linkedInboxAccountId: null,
      },
    ],
    mcpWriteAudit: [],
  });
  dbHolder.current = db;
});

afterEach(() => {
  expect(sendEmail).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

describe("a key that cannot write never sees create_draft", () => {
  const cases: Array<[string, "read" | "read_write", string | undefined, string]> = [
    ["flag off, read key", "read", undefined, "PRO"],
    ["flag off, read_write key", "read_write", undefined, "PRO"],
    ["flag on, read key", "read", "true", "PRO"],
    ["flag on, read_write key, FREE plan (no email_write)", "read_write", "true", "FREE"],
  ];
  for (const [label, permission, flag, plan] of cases) {
    it(`${label}: not listed, answered exactly like an unknown tool, no draft made`, async () => {
      if (flag) vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", flag);
      const client = await connect(permission, plan);
      expect(await toolNames(client)).not.toContain("create_draft");
      const result = await draftCall(client);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ error: "Unknown tool: create_draft" }) }],
        isError: true,
      });
      expect(createDraft).not.toHaveBeenCalled();
      expect(mailActionsFor).not.toHaveBeenCalled();
    });
  }

  it("flag off writes no audit row for the refused call, on any key", async () => {
    for (const permission of ["read", "read_write"] as const) {
      const client = await connect(permission);
      await draftCall(client);
    }
    expect(db.writes.mcpWriteAudit).toBeUndefined();
  });

  it("flag on: a read key's refused call leaves exactly one refused row, not a draft", async () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    const client = await connect("read");
    await draftCall(client);
    await draftCall(client);
    // The refused-row write is fire-and-forget: let it land.
    await vi.waitFor(() => expect(db.tables.mcpWriteAudit).toHaveLength(1));
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({
      tool: "create_draft",
      outcome: "refused",
      reason: "permission_denied",
    });
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe("flag off: every tool list and result is what main served", () => {
  it("a read_write key lists only the read tools and read results are untouched", async () => {
    const client = await connect("read_write");
    expect(await toolNames(client)).toEqual(["list_emails", "read_email"]);
    expect(await client.callTool({ name: "list_emails", arguments: {} })).toEqual({
      content: [{ type: "text", text: LIST_RAW }],
    });
    expect(db.reads).toEqual([]);
  });
});

describe("a read_write key with the flag on", () => {
  beforeEach(() => vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true"));

  it("lists create_draft last, with email_id and body required and no recipient field", async () => {
    const client = await connect("read_write");
    expect(await toolNames(client)).toEqual([
      "list_emails",
      "read_email",
      "mark_read",
      "set_tier",
      "create_draft",
    ]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "create_draft");
    expect(tool?.inputSchema.required).toEqual(["email_id", "body"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "body",
      "email_id",
      "subject",
    ]);
  });

  it("creates the draft, answers {draft_id, provider, to}, and audits it: attempted first, settled ok, target = email_id", async () => {
    const client = await connect("read_write");
    const order: string[] = [];
    const realCreate = db.model("mcpWriteAudit").create;
    db.model("mcpWriteAudit").create = async (args) => {
      order.push("audit-insert");
      return realCreate(args);
    };
    createDraft.mockImplementationOnce(async () => {
      order.push("draft");
      expect(db.tables.mcpWriteAudit[0]).toMatchObject({ outcome: "attempted" });
      return { success: true, draftId: "draft-7", url: "u" };
    });

    const result = await draftCall(client, { subject: "Thursday" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({
      success: true,
      draft_id: "draft-7",
      provider: "GOOGLE",
      to: "alice@example.com",
    });
    expect(order).toEqual(["audit-insert", "draft"]);
    expect(createDraft).toHaveBeenCalledWith(user, {
      to: "alice@example.com",
      subject: "Thursday",
      body: BODY,
      threadId: "thread-1",
      linkedInboxAccountId: null,
      reply: { inReplyTo: "<orig@mail.example>", references: "<orig@mail.example>" },
    });
    expect(db.tables.mcpWriteAudit).toHaveLength(1);
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({
      tool: "create_draft",
      apiKeyId: key,
      userId: user,
      targetId: EMAIL_ID,
      outcome: "ok",
      reason: null,
    });
    // No mail content in the audit row: only the argument hash.
    expect(JSON.stringify(db.tables.mcpWriteAudit[0])).not.toContain(BODY);
    // Its own executor: the shared tool executor was never involved.
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("an Outlook mailbox answers an explicit unsupported result, creates nothing, and settles error", async () => {
    mailActionsFor.mockResolvedValue({
      provider: "OUTLOOK",
      sendEmail,
      createDraft,
      getReplyHeaders,
    });
    const client = await connect("read_write");
    const result = await draftCall(client);
    expect(JSON.parse(textOf(result))).toMatchObject({ unsupported: true });
    expect(createDraft).not.toHaveBeenCalled();
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({
      tool: "create_draft",
      outcome: "error",
      reason: "tool_error",
    });
  });

  it("a header-injecting subject is refused, nothing is created, and the audit row settles error", async () => {
    const client = await connect("read_write");
    const result = await draftCall(client, { subject: "Hi\r\nBcc: attacker@evil.test" });
    expect(JSON.parse(textOf(result))).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(createDraft).not.toHaveBeenCalled();
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({ outcome: "error", reason: "tool_error" });
  });

  it("another user's mail is not found and nothing is created", async () => {
    Object.assign(db.tables.emailMessage[0], { userId: "someone-else" });
    const client = await connect("read_write");
    const result = await draftCall(client);
    expect(JSON.parse(textOf(result))).toMatchObject({ code: "NOT_FOUND" });
    expect(createDraft).not.toHaveBeenCalled();
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({ outcome: "error", reason: "tool_error" });
  });

  it("a recipient argument is refused through the server as well", async () => {
    const client = await connect("read_write");
    const result = await draftCall(client, { to: "attacker@evil.test" });
    expect(JSON.parse(textOf(result))).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("the audit row identifies a 15,000-character draft by hashes and ids, and stores none of its text", async () => {
    const body = "Thursday works for me. ".repeat(700); // 16,100 characters: over the 4 KB args-hash limit
    expect(body.length).toBeGreaterThan(15_000);
    const client = await connect("read_write");
    const result = await draftCall(client, { body });
    expect(JSON.parse(textOf(result))).toMatchObject({ success: true, draft_id: "draft-7" });
    const [row] = db.tables.mcpWriteAudit;
    expect(row).toMatchObject({
      tool: "create_draft",
      outcome: "ok",
      targetId: EMAIL_ID,
      // The content identity: SHA-256 of the body as it was handed to the provider.
      bodyHash: sha256(body),
      // The destination identity: SHA-256 of the lowercased resolved recipient.
      recipientHash: sha256("alice@example.com"),
      draftId: "draft-7",
    });
    // The 4 KB args limit still applies, so the args hash alone cannot tell two long drafts apart.
    expect(row.argsHash).toBe(hashToolArgs({ email_id: EMAIL_ID, body }));
    expect(row.argsHash).toBe(hashToolArgs({ email_id: EMAIL_ID, body: "z".repeat(body.length) }));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("Thursday works");
    expect(stored).not.toContain("alice@example.com");
  });

  it("two different long drafts to the same email leave different body hashes", async () => {
    const client = await connect("read_write");
    await draftCall(client, { body: "a".repeat(15_000) });
    await draftCall(client, { body: "b".repeat(15_000) });
    const [first, second] = db.tables.mcpWriteAudit;
    expect(first.bodyHash).not.toBe(second.bodyHash);
  });

  it("a refused call (bad subject) still records the body hash of what it tried, with no draft id or recipient", async () => {
    const client = await connect("read_write");
    await draftCall(client, { subject: "Hi\r\nBcc: x@y.co" });
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({
      outcome: "error",
      bodyHash: sha256(BODY),
      draftId: null,
      recipientHash: null,
    });
  });

  it("an identical retry returns the first draft, creates nothing, and is audited as its own ok row with the same draft id", async () => {
    const client = await connect("read_write");
    const first = JSON.parse(textOf(await draftCall(client)));
    const again = JSON.parse(textOf(await draftCall(client)));
    expect(first).not.toHaveProperty("deduplicated");
    expect(again).toEqual({ ...first, deduplicated: true });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(db.tables.mcpWriteAudit).toHaveLength(2);
    for (const row of db.tables.mcpWriteAudit) {
      expect(row).toMatchObject({ outcome: "ok", draftId: "draft-7", bodyHash: sha256(BODY) });
    }
  });

  const distinctDraft = (client: Client, i: number) => draftCall(client, { body: `${BODY} #${i}` });

  it("has its own cap of 10 drafts a minute, well under the shared write cap", async () => {
    const client = await connect("read_write");
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++) {
      const result = await distinctDraft(client, i);
      expect(result.isError, `draft ${i + 1}`).toBeUndefined();
    }
    expect(createDraft).toHaveBeenCalledTimes(MCP_CREATE_DRAFT_CAP_PER_WINDOW);
    const over = await distinctDraft(client, 99);
    expect(over.isError).toBe(true);
    expect(JSON.parse(textOf(over))).toMatchObject({ code: "RATE_LIMITED" });
    expect(createDraft).toHaveBeenCalledTimes(MCP_CREATE_DRAFT_CAP_PER_WINDOW);
    await vi.waitFor(() =>
      expect(db.tables.mcpWriteAudit).toHaveLength(MCP_CREATE_DRAFT_CAP_PER_WINDOW + 1),
    );
    expect(db.tables.mcpWriteAudit.at(-1)).toMatchObject({
      tool: "create_draft",
      outcome: "refused",
      reason: "rate_limited",
    });
  });

  it("the draft cap is per user, shared across that user's keys", async () => {
    const first = await connect("read_write", "PRO", `${key}-a`);
    const second = await connect("read_write", "PRO", `${key}-b`);
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++) {
      await distinctDraft(i % 2 ? first : second, i);
    }
    const over = await distinctDraft(first, 99);
    expect(JSON.parse(textOf(over))).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("counts against the shared write cap: 20 mark_reads plus 10 drafts use it up, and then every write is refused", async () => {
    const client = await connect("read_write");
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW - MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++) {
      await client.callTool({ name: "mark_read", arguments: { email_id: EMAIL_ID } });
    }
    for (let i = 0; i < MCP_CREATE_DRAFT_CAP_PER_WINDOW; i++) await distinctDraft(client, i);
    expect(createDraft).toHaveBeenCalledTimes(MCP_CREATE_DRAFT_CAP_PER_WINDOW);
    const read = await client.callTool({ name: "mark_read", arguments: { email_id: EMAIL_ID } });
    expect(JSON.parse(textOf(read))).toMatchObject({ code: "RATE_LIMITED" });
    const overDraft = await distinctDraft(client, 99);
    expect(JSON.parse(textOf(overDraft))).toMatchObject({ code: "RATE_LIMITED" });
    expect(createDraft).toHaveBeenCalledTimes(MCP_CREATE_DRAFT_CAP_PER_WINDOW);
  });

  it("a failed audit insert refuses the call and no draft is created", async () => {
    db.model("mcpWriteAudit").create = async () => {
      throw new Error("db down");
    };
    const client = await connect("read_write");
    const result = await draftCall(client);
    expect(result.isError).toBe(true);
    expect(createDraft).not.toHaveBeenCalled();
  });
});
