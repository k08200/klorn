/**
 * Agent-mode metadata + label/description/class formatters used by the
 * settings page's Decision Agent section.
 *
 * Split out of page.tsx so the 1892-line settings surface has its pure
 * agent-mode logic in one focused module. No behavior change — every
 * function body is byte-identical to its original location.
 */

export type AgentMode = "SHADOW" | "SUGGEST" | "AUTO";

export interface AgentModeOption {
  mode: AgentMode;
  label: string;
  description: string;
  autonomyLevel?: number;
}

export interface ApiAgentModeOption {
  mode?: string;
  label?: string;
  description?: string;
  autonomyLevel?: number;
}

export const DEFAULT_AGENT_MODE_OPTIONS: AgentModeOption[] = [
  { mode: "SHADOW", label: "Observe", description: "Prepare quietly" },
  { mode: "SUGGEST", label: "Review", description: "Ask before action" },
  { mode: "AUTO", label: "Auto", description: "Run safe actions" },
];

export function normalizeAgentMode(value: string | undefined): AgentMode {
  if (value === "SHADOW" || value === "SUGGEST" || value === "AUTO") return value;
  return "SUGGEST";
}

export function normalizeAgentModeOptions(
  options: ApiAgentModeOption[] | undefined,
): AgentModeOption[] {
  if (!options?.length) return DEFAULT_AGENT_MODE_OPTIONS;
  const seen = new Set<AgentMode>();
  const normalized = options.flatMap((option) => {
    const mode = normalizeAgentMode(option.mode);
    if (seen.has(mode)) return [];
    seen.add(mode);
    return [
      {
        mode,
        label: option.label || mode,
        description:
          option.description ||
          DEFAULT_AGENT_MODE_OPTIONS.find((fallback) => fallback.mode === mode)?.description ||
          mode,
        autonomyLevel: option.autonomyLevel,
      },
    ];
  });
  return normalized.length > 0 ? normalized : DEFAULT_AGENT_MODE_OPTIONS;
}

export function agentModeToast(mode: AgentMode): string {
  switch (mode) {
    case "SHADOW":
      return "Observe mode - Klorn prepares quietly";
    case "AUTO":
      return "Auto mode - safe actions can run automatically";
    case "SUGGEST":
      return "Review mode - Klorn asks before acting";
  }
}

export function agentModeDescription(option: AgentModeOption): string {
  const fallback = DEFAULT_AGENT_MODE_OPTIONS.find((item) => item.mode === option.mode);
  if (/[\uAC00-\uD7AF]/u.test(option.description)) {
    return fallback?.description || option.mode;
  }
  return option.description || fallback?.description || option.mode;
}

export function agentModeLabel(option: AgentModeOption): string {
  const labels: Record<AgentMode, string> = {
    SHADOW: "Observe",
    SUGGEST: "Review",
    AUTO: "Auto",
  };
  return labels[option.mode] || option.label;
}

export function agentModeClasses(mode: AgentMode, active: boolean): string {
  if (!active) return "bg-stone-900 border-stone-700 text-stone-400 hover:border-stone-600";
  if (mode === "SHADOW") return "bg-stone-800/80 border-stone-500/60 text-stone-100";
  if (mode === "AUTO") return "bg-emerald-500/15 border-emerald-400/45 text-emerald-200";
  return "bg-amber-300/20 border-amber-300/50 text-amber-100";
}

export const TIMEZONES = [
  "Asia/Seoul",
  "Asia/Tokyo",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
];
