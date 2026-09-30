/**
 * MCP tool gate (step A2a of docs/providers/unified-platform-plan.md) — the ONE
 * function that decides which tools a key may see and call. Real registry, real
 * chat whitelist, real plan gate: only the DB and Sentry are mocked, so a change
 * to ALL_TOOLS, CHAT_TOOL_NAMES or the autonomous agent's risk table fails here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {}, db: {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { TOOL_RISK_LEVELS } from "../agentcore/agent-logic.js";
import { CHAT_TOOL_NAMES } from "../agentcore/chat-engine.js";
import { ALL_TOOLS, isToolAllowedForPlan } from "../agentcore/tool-executor.js";
import { teamModeEnabled } from "../config.js";
import { SET_TIER_TOOL } from "../mcp/set-tier.js";
import { MCP_WRITE_TOOL_NAMES, mcpToolDefs } from "../mcp/tool-gate.js";
import { WRITE_TOOL_SUCCESS } from "../mcp/write-call.js";

const markReadDef = () => ALL_TOOLS.filter((t) => t.function.name === "mark_read");

/** `mcpToolDefs(plan)` exactly as it shipped on main at 03de6426, verbatim. */
function legacyMcpToolDefs(plan: string) {
  const MCP_EXCLUDED = new Set(["create_event"]);
  return ALL_TOOLS.filter(
    (tool) =>
      CHAT_TOOL_NAMES.has(tool.function.name) &&
      !MCP_EXCLUDED.has(tool.function.name) &&
      (tool.function.name !== "team_availability" || teamModeEnabled()) &&
      isToolAllowedForPlan(tool.function.name, plan),
  );
}

const names = (defs: readonly { function: { name: string } }[]) => defs.map((d) => d.function.name);

const READ_TOOLS_TEAM_OFF = [
  "generate_briefing",
  "sender_context",
  "get_current_time",
  "list_emails",
  "read_email",
  "classify_emails",
  "list_events",
  "check_calendar_conflicts",
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("surfaces other than MCP are pinned (A2a adds nothing to them)", () => {
  it("ALL_TOOLS is exactly today's registry — feeds the autonomous agent", () => {
    expect(names(ALL_TOOLS)).toEqual([
      "generate_briefing",
      "get_upcoming_meetings",
      "join_meeting",
      "summarize_meeting",
      "calculate",
      "generate_password",
      "remember",
      "recall",
      "forget",
      "execute_skill",
      "list_skills",
      "sender_context",
      "team_availability",
      "get_current_time",
      "list_emails",
      "read_email",
      "classify_emails",
      "send_email",
      "mark_read",
      "list_events",
      "create_event",
      "check_calendar_conflicts",
      "delete_event",
    ]);
  });

  it("CHAT_TOOL_NAMES is exactly today's chat surface and does not contain mark_read", () => {
    expect([...CHAT_TOOL_NAMES]).toEqual([
      "list_emails",
      "read_email",
      "sender_context",
      "team_availability",
      "classify_emails",
      "list_events",
      "check_calendar_conflicts",
      "get_current_time",
      "generate_briefing",
      "create_event",
    ]);
    expect(CHAT_TOOL_NAMES.has("mark_read")).toBe(false);
  });

  it("the autonomous agent's risk table is unchanged (its tool list is ALL_TOOLS filtered by it)", () => {
    expect([...TOOL_RISK_LEVELS.entries()]).toEqual([
      ["classify_emails", "LOW"],
      ["mark_read", "LOW"],
      ["generate_briefing", "LOW"],
      ["send_email", "MEDIUM"],
      ["create_event", "MEDIUM"],
      ["execute_skill", "LOW"],
      ["list_skills", "LOW"],
      ["record_skill", "MEDIUM"],
      ["delete_event", "HIGH"],
      ["archive_email", "HIGH"],
      ["delete_email", "HIGH"],
    ]);
  });
});

describe("literal tool lists per plan (team mode off) — written out, not derived", () => {
  const PAID_OR_FREE_READ = [
    "generate_briefing",
    "sender_context",
    "get_current_time",
    "list_emails",
    "read_email",
    "classify_emails",
    "list_events",
    "check_calendar_conflicts",
  ];

  for (const plan of ["FREE", "PRO"]) {
    it(`${plan}: read key, flag off -> the eight read tools`, () => {
      expect(names(mcpToolDefs(plan, "read"))).toEqual(PAID_OR_FREE_READ);
    });

    it(`${plan}: read_write key, flag off -> still the eight read tools`, () => {
      expect(names(mcpToolDefs(plan, "read_write"))).toEqual(PAID_OR_FREE_READ);
    });

    it(`${plan}: read key, flag on -> still the eight read tools`, () => {
      vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
      expect(names(mcpToolDefs(plan, "read"))).toEqual(PAID_OR_FREE_READ);
    });

    it(`${plan}: read_write key, flag on -> the eight read tools, then mark_read, then set_tier`, () => {
      vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
      expect(names(mcpToolDefs(plan, "read_write"))).toEqual([
        ...PAID_OR_FREE_READ,
        "mark_read",
        "set_tier",
      ]);
    });
  }

  it("a plan with no features keeps only the ungated tools and gets no write tool either", () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    const ungated = ["generate_briefing", "sender_context", "get_current_time"];
    expect(names(mcpToolDefs("NO_SUCH_PLAN", "read"))).toEqual(ungated);
    expect(names(mcpToolDefs("NO_SUCH_PLAN", "read_write"))).toEqual(ungated);
  });

  it("team mode on inserts team_availability after sender_context (PRO, read key)", () => {
    vi.stubEnv("TEAM_MODE_ENABLED", "true");
    expect(names(mcpToolDefs("PRO", "read"))).toEqual([
      "generate_briefing",
      "sender_context",
      "team_availability",
      "get_current_time",
      "list_emails",
      "read_email",
      "classify_emails",
      "list_events",
      "check_calendar_conflicts",
    ]);
  });
});

describe("the write set", () => {
  it("has a success predicate for every member, so no write tool settles by accident", () => {
    expect(Object.keys(WRITE_TOOL_SUCCESS).sort()).toEqual([...MCP_WRITE_TOOL_NAMES].sort());
  });

  it("is exactly mark_read then set_tier", () => {
    expect([...MCP_WRITE_TOOL_NAMES]).toEqual(["mark_read", "set_tier"]);
  });

  it("mark_read reuses its ALL_TOOLS definition; set_tier is MCP-only and is in neither registry", () => {
    expect(names(ALL_TOOLS)).toContain("mark_read");
    expect(names(ALL_TOOLS)).not.toContain("set_tier");
    expect(CHAT_TOOL_NAMES.has("set_tier")).toBe(false);
    expect(TOOL_RISK_LEVELS.has("set_tier")).toBe(false);
    expect(SET_TIER_TOOL.function.name).toBe("set_tier");
  });

  it("set_tier's schema offers exactly the five lanes (never AUTO or CALL) and requires both arguments", () => {
    const params = SET_TIER_TOOL.function.parameters as {
      required: string[];
      properties: { tier: { enum: string[] }; email_id: { type: string } };
    };
    expect(params.properties.tier.enum).toEqual(["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"]);
    expect(params.required).toEqual(["email_id", "tier"]);
    expect(params.properties.email_id.type).toBe("string");
  });

  it("set_tier is plan-gated exactly like mark_read, for every plan", () => {
    for (const plan of ["FREE", "PRO", "TEAM", "ENTERPRISE", "NO_SUCH_PLAN"]) {
      expect(isToolAllowedForPlan("set_tier", plan), plan).toBe(
        isToolAllowedForPlan("mark_read", plan),
      );
    }
  });

  it("is disjoint from the chat whitelist, so it can never reach chat by accident", () => {
    for (const name of MCP_WRITE_TOOL_NAMES) {
      expect(CHAT_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});

describe("mcpToolDefs(plan, permission) — flag x permission x plan", () => {
  const PLANS = ["FREE", "PRO", "TEAM", "ENTERPRISE", "NO_SUCH_PLAN"];
  const FLAGS = [
    { label: "off (unset)", value: undefined },
    { label: "off (false)", value: "false" },
    { label: "on", value: "true" },
  ];

  for (const plan of PLANS) {
    for (const flag of FLAGS) {
      for (const permission of ["read", "read_write"] as const) {
        const writesVisible =
          permission === "read_write" && flag.value === "true" && plan !== "NO_SUCH_PLAN";
        it(`plan=${plan} flag=${flag.label} permission=${permission} -> ${
          writesVisible ? "read set + mark_read + set_tier" : "read set only"
        }`, () => {
          if (flag.value !== undefined) vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", flag.value);
          const legacy = legacyMcpToolDefs(plan);
          const got = mcpToolDefs(plan, permission);
          const expected = writesVisible ? [...legacy, ...markReadDef(), SET_TIER_TOOL] : legacy;
          // Byte-identical: same definitions, same order, same serialisation.
          expect(JSON.stringify(got)).toBe(JSON.stringify(expected));
        });
      }
    }
  }

  it("read keys and flag OFF give today's eight tools, byte for byte (team mode off)", () => {
    expect(names(mcpToolDefs("PRO", "read"))).toEqual(READ_TOOLS_TEAM_OFF);
    expect(JSON.stringify(mcpToolDefs("PRO", "read"))).toBe(
      JSON.stringify(legacyMcpToolDefs("PRO")),
    );
  });

  it("team_availability still needs teamModeEnabled(), for read and read_write alike", () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    vi.stubEnv("TEAM_MODE_ENABLED", "true");
    expect(names(mcpToolDefs("PRO", "read"))).toContain("team_availability");
    expect(names(mcpToolDefs("PRO", "read_write"))).toContain("team_availability");
    vi.stubEnv("TEAM_MODE_ENABLED", "false");
    expect(names(mcpToolDefs("PRO", "read_write"))).not.toContain("team_availability");
  });

  it("re-reads the flag on every call (defence in depth: permission alone never grants a write)", () => {
    expect(names(mcpToolDefs("PRO", "read_write"))).not.toContain("set_tier");
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    expect(names(mcpToolDefs("PRO", "read_write"))).toContain("mark_read");
    expect(names(mcpToolDefs("PRO", "read_write"))).toContain("set_tier");
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "false");
    expect(names(mcpToolDefs("PRO", "read_write"))).not.toContain("mark_read");
    expect(names(mcpToolDefs("PRO", "read_write"))).not.toContain("set_tier");
  });

  it("keeps create_event, send_email and delete_event out for every combination", () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    for (const permission of ["read", "read_write"] as const) {
      const listed = names(mcpToolDefs("PRO", permission));
      for (const banned of ["create_event", "send_email", "delete_event", "delete_email"]) {
        expect(listed).not.toContain(banned);
      }
    }
  });

  it("treats anything but the exact read_write string as read", () => {
    vi.stubEnv("MCP_WRITE_TOOLS_ENABLED", "true");
    for (const bogus of ["", "READ_WRITE", "write", "admin", undefined, null]) {
      expect(names(mcpToolDefs("PRO", bogus as never))).not.toContain("mark_read");
      expect(names(mcpToolDefs("PRO", bogus as never))).not.toContain("set_tier");
    }
  });
});
