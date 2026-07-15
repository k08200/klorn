export const AGENT_MODES = ["SHADOW", "SUGGEST", "AUTO"] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

export const AUTOPILOT_LEVEL = {
  OBSERVE: 0,
  SUGGEST: 1,
  APPROVAL: 2,
  SAFE_AUTO: 3,
} as const;

export type AutopilotLevel = (typeof AUTOPILOT_LEVEL)[keyof typeof AUTOPILOT_LEVEL];

export interface AgentModePolicy {
  mode: AgentMode;
  autonomyLevel: AutopilotLevel;
  label: string;
  description: string;
  proposalNotifications: boolean;
  lowRiskAutoExecution: boolean;
  mediumRiskPreApproval: boolean;
}

export const AGENT_MODE_POLICIES: Record<AgentMode, AgentModePolicy> = {
  SHADOW: {
    mode: "SHADOW",
    autonomyLevel: AUTOPILOT_LEVEL.OBSERVE,
    label: "SHADOW",
    description: "Prepare quietly",
    proposalNotifications: false,
    lowRiskAutoExecution: false,
    mediumRiskPreApproval: false,
  },
  SUGGEST: {
    mode: "SUGGEST",
    autonomyLevel: AUTOPILOT_LEVEL.SUGGEST,
    label: "SUGGEST",
    description: "Ask before action",
    proposalNotifications: true,
    lowRiskAutoExecution: false,
    mediumRiskPreApproval: false,
  },
  AUTO: {
    mode: "AUTO",
    autonomyLevel: AUTOPILOT_LEVEL.SAFE_AUTO,
    label: "AUTO",
    description: "Run safe actions",
    proposalNotifications: true,
    lowRiskAutoExecution: true,
    mediumRiskPreApproval: true,
  },
};

export function normalizeAgentMode(value: unknown): AgentMode {
  return AGENT_MODES.includes(value as AgentMode) ? (value as AgentMode) : "SUGGEST";
}

export function getAgentModePolicy(value: unknown): AgentModePolicy {
  return AGENT_MODE_POLICIES[normalizeAgentMode(value)];
}

export function listAgentModePolicies(): AgentModePolicy[] {
  return AGENT_MODES.map((mode) => AGENT_MODE_POLICIES[mode]);
}
