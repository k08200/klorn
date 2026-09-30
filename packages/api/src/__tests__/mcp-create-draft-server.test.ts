/**
 * create_draft through the real MCP server (step A4): ListTools and CallTool as
 * a client sees them. The shared tool registry and executor are faked (as in
 * mcp-set-tier-server.test.ts) so every read result is a known byte string, but
 * the plan gate is REAL (the real feature map decides who may draft). The gate,
 * the write call, the audit row, the per-user cap and create_draft itself are real;
 * only the provider seam is a spy.
 */

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
import { MCP_WRITE_CAP_PER_WINDOW } from "../mcp/write-call.js";

const LIST_RAW = JSON.stringify([{ id: "18c3f0a1b2c3d4e5", from: "a@b.co", subject: "Hi" }]);
const EMAIL_ID = "18c3f0a1b2c3d4e5";
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

  it("counts against the per-user write cap, shared with the other write tools, and the audit row is written before each run", async () => {
    const client = await connect("read_write");
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) {
      const result = await draftCall(client);
      expect(result.isError, `call ${i + 1}`).toBeUndefined();
    }
    expect(createDraft).toHaveBeenCalledTimes(MCP_WRITE_CAP_PER_WINDOW);
    const over = await draftCall(client);
    expect(over.isError).toBe(true);
    expect(JSON.parse(textOf(over))).toMatchObject({ code: "RATE_LIMITED" });
    expect(createDraft).toHaveBeenCalledTimes(MCP_WRITE_CAP_PER_WINDOW);
    await vi.waitFor(() =>
      expect(db.tables.mcpWriteAudit).toHaveLength(MCP_WRITE_CAP_PER_WINDOW + 1),
    );
    expect(db.tables.mcpWriteAudit.at(-1)).toMatchObject({
      outcome: "refused",
      reason: "rate_limited",
    });
  });

  it("the cap is per user: a second key of the same user shares the budget with create_draft", async () => {
    const first = await connect("read_write", "PRO", `${key}-a`);
    const second = await connect("read_write", "PRO", `${key}-b`);
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) await draftCall(i % 2 ? first : second);
    const over = await draftCall(first);
    expect(JSON.parse(textOf(over))).toMatchObject({ code: "RATE_LIMITED" });
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
