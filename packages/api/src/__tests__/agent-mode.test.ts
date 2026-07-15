import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_LEVEL,
  getAgentModePolicy,
  listAgentModePolicies,
  normalizeAgentMode,
} from "../agentcore/agent-mode.js";

describe("normalizeAgentMode", () => {
  it("accepts the supported agent modes", () => {
    expect(normalizeAgentMode("SHADOW")).toBe("SHADOW");
    expect(normalizeAgentMode("SUGGEST")).toBe("SUGGEST");
    expect(normalizeAgentMode("AUTO")).toBe("AUTO");
  });

  it("falls back to SUGGEST for unknown values", () => {
    expect(normalizeAgentMode("LOUD")).toBe("SUGGEST");
    expect(normalizeAgentMode(null)).toBe("SUGGEST");
  });

  it("keeps mode policies in ladder order", () => {
    expect(listAgentModePolicies().map((p) => p.mode)).toEqual(["SHADOW", "SUGGEST", "AUTO"]);
    expect(getAgentModePolicy("SHADOW")).toMatchObject({
      autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
      proposalNotifications: false,
      lowRiskAutoExecution: false,
    });
    expect(getAgentModePolicy("AUTO")).toMatchObject({
      autonomyLevel: AUTOPILOT_LEVEL.SAFE_AUTO,
      proposalNotifications: true,
      lowRiskAutoExecution: true,
      mediumRiskPreApproval: true,
    });
  });
});
