/**
 * Admin ceilings are enforced server-side, where the work happens, not in a
 * route a client could skip: the shared pre-LLM guard of both unattended reply
 * paths, the deterministic send floor every auto-reply goes through, and the
 * entry of every autonomous agent run (scheduler, new-mail trigger, manual).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ceilings = vi.hoisted(() => ({
  value: { autoReplyDisabled: false, agentModeCap: null as string | null },
}));
// Every query is recorded; the membership lookup answers with the ceilings
// above, everything else with nothing.
const prismaSpy = vi.hoisted(() => {
  const calls: string[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          vi.fn(async () => {
            calls.push(`${name}.${method}`);
            if (name === "orgMembership" && method === "findUnique") {
              return { org: ceilings.value };
            }
            if (method === "count") return 0;
            if (method === "findMany") return [];
            return null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_target, name: string) => model(name) });
  return { calls, prisma };
});

vi.mock("../db.js", () => ({ prisma: prismaSpy.prisma, db: prismaSpy.prisma }));
const executeToolCall = vi.hoisted(() => vi.fn(async () => JSON.stringify({ success: true })));
vi.mock("../agentcore/tool-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agentcore/tool-executor.js")>()),
  executeToolCall,
}));

import { sendAutoReplyViaFloor } from "../agentcore/auto-reply-send.js";
import { unattendedReplyBlock } from "../agentcore/unattended-reply-guards.js";
import { AutoReplyBlockedByOrgError, agentModeUnderOrgCeiling } from "../org/ceilings.js";

const MEMBERSHIP_LOOKUP = "orgMembership.findUnique";

beforeEach(() => {
  vi.clearAllMocks();
  prismaSpy.calls.length = 0;
  ceilings.value = { autoReplyDisabled: false, agentModeCap: null };
  process.env.TEAMS_ENABLED = "true";
});

afterEach(() => {
  delete process.env.TEAMS_ENABLED;
});

describe("auto-reply off (org ceiling)", () => {
  const email = { from: "Partner <partner@external.test>" };

  it("blocks both unattended reply paths before any LLM or ledger work", async () => {
    ceilings.value = { autoReplyDisabled: true, agentModeCap: null };
    expect(await unattendedReplyBlock("u1", email)).toBe("org-policy");
    expect(prismaSpy.calls).toEqual([MEMBERSHIP_LOOKUP]);
  });

  it("leaves the guard to its other checks when the org allows auto-reply", async () => {
    expect(await unattendedReplyBlock("u1", email)).toBeNull();
  });

  it("refuses at the send floor, so nothing leaves even if a draft raced the switch", async () => {
    ceilings.value = { autoReplyDisabled: true, agentModeCap: null };
    await expect(
      sendAutoReplyViaFloor("u1", "partner@external.test", "Re: hi", "body"),
    ).rejects.toBeInstanceOf(AutoReplyBlockedByOrgError);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("reads no ceiling at all while TEAMS_ENABLED is off", async () => {
    delete process.env.TEAMS_ENABLED;
    ceilings.value = { autoReplyDisabled: true, agentModeCap: null };
    expect(await unattendedReplyBlock("u1", email)).toBeNull();
    expect(prismaSpy.calls).not.toContain(MEMBERSHIP_LOOKUP);
  });

  it("sends through the floor as before when no ceiling applies", async () => {
    await sendAutoReplyViaFloor("u1", "partner@external.test", "Re: hi", "body");
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });
});

describe("agent mode cap (org ceiling)", () => {
  it("caps every run's mode at the org ceiling", async () => {
    ceilings.value = { autoReplyDisabled: false, agentModeCap: "SUGGEST" };
    expect(await agentModeUnderOrgCeiling("u1", "AUTO")).toBe("SUGGEST");
    ceilings.value = { autoReplyDisabled: false, agentModeCap: "SHADOW" };
    expect(await agentModeUnderOrgCeiling("u1", "SUGGEST")).toBe("SHADOW");
    ceilings.value = { autoReplyDisabled: false, agentModeCap: null };
    expect(await agentModeUnderOrgCeiling("u1", "AUTO")).toBe("AUTO");
    expect(await agentModeUnderOrgCeiling("u1", "garbage")).toBe("SUGGEST");
  });

  it("keeps the re-entrancy guard atomic across the ceiling lookup", async () => {
    ceilings.value = { autoReplyDisabled: false, agentModeCap: "OFF" };
    const { runAgentForUser } = await import("../agentcore/autonomous-agent.js");
    await Promise.all([runAgentForUser("u-race", "AUTO"), runAgentForUser("u-race", "AUTO")]);
    // The second call saw the first one's claim and never looked anything up.
    expect(prismaSpy.calls).toEqual([MEMBERSHIP_LOOKUP]);
    // An OFF cap releases the claim, so the next run is not locked out.
    await runAgentForUser("u-race", "AUTO");
    expect(prismaSpy.calls).toEqual([MEMBERSHIP_LOOKUP, MEMBERSHIP_LOOKUP]);
  });

  it("does not run the agent at all under an OFF cap", async () => {
    ceilings.value = { autoReplyDisabled: false, agentModeCap: "OFF" };
    const { runAgentForUser } = await import("../agentcore/autonomous-agent.js");
    await runAgentForUser("u1", "AUTO");
    expect(prismaSpy.calls).toEqual([MEMBERSHIP_LOOKUP]);
  });
});
