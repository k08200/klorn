/**
 * set_tier through the real MCP server (step A2b): ListTools and CallTool as a
 * client sees them. The tool registry and the shared executor are faked (as in
 * routes-mcp.test.ts) so the read results are a known byte string; everything
 * else — the gate, the write call, the audit, set_tier itself — is real.
 *
 * Read visibility was decided in the write path (set_tier answers with the
 * previous and the new lane) rather than by enriching list_emails/read_email,
 * so these tests also pin that NO read result is altered for any key, flag
 * state or permission: the byte-identity guarantee is structural.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const executeToolCall = vi.hoisted(() => vi.fn());

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../agentcore/chat-engine.js", () => ({
  CHAT_TOOL_NAMES: new Set(["list_emails", "read_email"]),
}));
vi.mock("../agentcore/tool-executor.js", () => ({
  ALL_TOOLS: ["list_emails", "read_email", "mark_read"].map((name) => ({
    type: "function",
    function: { name, description: `${name} desc`, parameters: { type: "object", properties: {} } },
  })),
  executeToolCall,
  isToolAllowedForPlan: vi.fn(() => true),
}));

import { buildMcpServer } from "../mcp/server.js";

const USER = "user-1";
const LIST_RAW = JSON.stringify([{ id: "18c3f0a1b2c3d4e5", from: "a@b.co", subject: "Hi" }]);
const READ_RAW = JSON.stringify({ id: "18c3f0a1b2c3d4e5", subject: "Hi", body: "Hello" });

let db: FakeDb;

async function connect(permission: "read" | "read_write") {
  const server = buildMcpServer(USER, "PRO", { keyId: "key-1", permission });
  const client = new Client({ name: "t", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

beforeEach(() => {
  executeToolCall.mockReset();
  executeToolCall.mockImplementation(async (_u: string, name: string) =>
    name === "list_emails" ? LIST_RAW : READ_RAW,
  );
  db = createFakeDb({
    emailMessage: [{ id: "email-db-1", userId: USER, gmailId: "18c3f0a1b2c3d4e5" }],
    attentionItem: [
      {
        id: "item-1",
        userId: USER,
        source: "EMAIL",
        sourceId: "email-db-1",
        status: "OPEN",
        tier: "QUEUE",
        isManualOverride: false,
        agentTierSetAt: null,
        agentTierKeyId: null,
      },
    ],
    decisionLabel: [],
    mcpWriteAudit: [],
  });
  dbHolder.current = db;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a key that cannot write never sees set_tier", () => {
  const cases: Array<[string, "read" | "read_write", string | undefined]> = [
    ["flag off, read key", "read", undefined],
    ["flag off, read_write key", "read_write", undefined],
    ["flag on, read key", "read", "true"],
  ];
  for (const [label, permission, flag] of cases) {
    it(`${label}: not listed, answered exactly like an unknown tool, nothing written`, async () => {
      if (flag) vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", flag);
      const client = await connect(permission);
      expect(await toolNames(client)).toEqual(["list_emails", "read_email"]);
      const result = await client.callTool({
        name: "set_tier",
        arguments: { email_id: "email-db-1", tier: "PUSH" },
      });
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ error: "Unknown tool: set_tier" }) }],
        isError: true,
      });
      expect(db.writes.attentionItem).toBeUndefined();
      expect(db.tables.attentionItem[0].tier).toBe("QUEUE");
    });
  }
});

describe("every read result is byte-identical to the shared executor's output, for every key", () => {
  const cases: Array<[string, "read" | "read_write", string | undefined]> = [
    ["flag off, read key", "read", undefined],
    ["flag off, read_write key", "read_write", undefined],
    ["flag on, read key", "read", "true"],
    ["flag on, read_write key (set_tier available)", "read_write", "true"],
  ];
  for (const [label, permission, flag] of cases) {
    it(`${label}: list_emails and read_email come back untouched`, async () => {
      if (flag) vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", flag);
      const client = await connect(permission);
      expect(await client.callTool({ name: "list_emails", arguments: {} })).toEqual({
        content: [{ type: "text", text: LIST_RAW }],
      });
      expect(
        await client.callTool({ name: "read_email", arguments: { email_id: "18c3f0a1b2c3d4e5" } }),
      ).toEqual({ content: [{ type: "text", text: READ_RAW }] });
      expect(db.reads).toEqual([]);
    });
  }
});

describe("a read_write key with the flag on", () => {
  beforeEach(() => vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true"));

  it("lists set_tier after mark_read (create_draft last), with the five-lane enum in its schema", async () => {
    const client = await connect("read_write");
    expect(await toolNames(client)).toEqual([
      "list_emails",
      "read_email",
      "mark_read",
      "set_tier",
      "create_draft",
    ]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "set_tier");
    expect(tool?.inputSchema).toMatchObject({
      properties: { tier: { enum: ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"] } },
      required: ["email_id", "tier"],
    });
  });

  it("changes the lane, answers previous and new lane, audits before and settles ok", async () => {
    const client = await connect("read_write");
    const result = await client.callTool({
      name: "set_tier",
      arguments: { email_id: "18c3f0a1b2c3d4e5", tier: "PUSH" },
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({
      success: true,
      email_id: "18c3f0a1b2c3d4e5",
      previous_tier: "QUEUE",
      tier: "PUSH",
      changed: true,
    });
    expect(db.tables.attentionItem[0]).toMatchObject({ tier: "PUSH", isManualOverride: false });
    expect(db.tables.mcpWriteAudit).toHaveLength(1);
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({
      tool: "set_tier",
      apiKeyId: "key-1",
      targetId: "18c3f0a1b2c3d4e5",
      outcome: "ok",
      // The change itself, so the activity log can show it and a revert is possible.
      tierFrom: "QUEUE",
      tierTo: "PUSH",
    });
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("an invalid lane is an explicit error, nothing changes, and the audit row settles to error", async () => {
    const client = await connect("read_write");
    const result = await client.callTool({
      name: "set_tier",
      arguments: { email_id: "18c3f0a1b2c3d4e5", tier: "AUTO" },
    });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(db.tables.attentionItem[0].tier).toBe("QUEUE");
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({
      outcome: "error",
      reason: "tool_error",
      tierFrom: null,
      tierTo: null,
    });
  });

  it("a human-overridden item is refused with an explicit result and left exactly as it was", async () => {
    Object.assign(db.tables.attentionItem[0], { tier: "SILENT", isManualOverride: true });
    const client = await connect("read_write");
    const result = await client.callTool({
      name: "set_tier",
      arguments: { email_id: "18c3f0a1b2c3d4e5", tier: "PUSH" },
    });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      code: "MANUAL_OVERRIDE",
    });
    expect(db.tables.attentionItem[0]).toMatchObject({ tier: "SILENT", isManualOverride: true });
    expect(db.tables.mcpWriteAudit[0]).toMatchObject({ outcome: "error", reason: "tool_error" });
  });
});
