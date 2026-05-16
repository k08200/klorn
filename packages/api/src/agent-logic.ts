/**
 * Agent Decision Logic — Pure functions used by the autonomous agent.
 *
 * Extracted from autonomous-agent.ts so they can be imported without
 * pulling in the full agent runtime (OpenAI client, Gmail, Prisma).
 * Enables focused unit tests and the agent-eval harness.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

/**
 * Tool risk classification — controls how the autonomous agent handles each tool.
 * - LOW: safe, executes automatically in AUTO mode
 * - MEDIUM: external-facing, requires approval (or pre-approval via alwaysAllowedTools)
 * - HIGH: destructive, always requires explicit user confirmation
 */
export const TOOL_RISK_LEVELS = new Map<string, RiskLevel>([
  // LOW — safe, easily reversible, no external side effects
  ["create_reminder", "LOW"],
  ["dismiss_reminder", "LOW"],
  ["update_task", "LOW"],
  ["classify_emails", "LOW"],
  ["create_task", "LOW"],
  ["update_note", "LOW"],
  ["mark_read", "LOW"],

  // MEDIUM — external-facing, requires user approval before sending
  ["send_email", "MEDIUM"],

  // MEDIUM — external-facing or calendar changes, reversible but visible
  ["create_event", "MEDIUM"],
  ["create_note", "MEDIUM"],
  ["update_contact", "MEDIUM"],
  ["create_contact", "MEDIUM"],

  // MEDIUM — skills can trigger external-facing tools (send_email, create_event)
  // through the agent reasoning loop, so they need explicit user approval.
  ["execute_skill", "MEDIUM"],
  ["list_skills", "LOW"],
  // MEDIUM — persists a new Skill definition; user must approve before it's saved.
  ["record_skill", "MEDIUM"],

  // HIGH — destructive or hard to reverse
  ["delete_task", "HIGH"],
  ["delete_reminder", "HIGH"],
  ["delete_note", "HIGH"],
  ["delete_event", "HIGH"],
  ["archive_email", "HIGH"],
  ["delete_email", "HIGH"],
]);

/** Get risk level for a tool. Returns undefined for read-only tools. */
export function getToolRisk(toolName: string): RiskLevel | undefined {
  return TOOL_RISK_LEVELS.get(toolName);
}

/**
 * Normalize a notification title for fuzzy dedup.
 * Catches slight variations like "스크럼 장소 확인" vs "스크럼 장소 중복 알림"
 * by stripping whitespace/punctuation and lowercasing to a 30-char key.
 */
export function getNotifKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s.,!?·\-_()[\]{}'"]/g, "")
    .slice(0, 30);
}

export interface ProposalIssueInput {
  message?: string | null;
  toolName?: string | null;
  toolArgs?: unknown;
}

const PROPOSAL_STOP_WORDS = new Set([
  "ev" + "e",
  "상황",
  "판단",
  "제안",
  "확인",
  "필요",
  "해드릴까요",
  "드릴까요",
  "있어요",
  "있고",
  "현재",
  "오늘",
  "내일",
  "여러",
  "관련",
  "기존",
  "최근",
  "사용자",
  "정리",
  "작업",
  "만들",
  "만들까",
  "추가",
  "삭제",
  "유지",
  "업데이트",
  "리마인더",
  "알림",
  "캘린더",
  "태스크",
  "시간",
  "대상",
  "요청",
  "내용",
  "승인",
  "거절",
  "pending",
  "action",
  "create",
  "update",
  "cleanup",
  "reminder",
  "calendar",
  "task",
  "optional",
  "single",
  "highlight",
]);

const MIN_PROPOSAL_SHARED_TOKENS = 4;
const MIN_PROPOSAL_OVERLAP_RATIO = 0.28;

export function proposalIssueTokens(input: ProposalIssueInput): Set<string> {
  const raw = [input.toolName, input.message, stringifyArgs(input.toolArgs)]
    .filter(Boolean)
    .join(" ");
  const normalized = raw
    .toLowerCase()
    .replace(/<untrusted_content>|<\/untrusted_content>/g, " ")
    .replace(/[_/\\|:;,.!?()[\]{}"'`~@#$%^&*+=<>]/g, " ");

  const tokens = normalized.match(/[a-z0-9]+|[가-힣]{2,}/g) ?? [];
  const kept = tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !PROPOSAL_STOP_WORDS.has(token))
    .filter((token) => token.length >= 2 || /^\d+$/.test(token));

  return new Set(kept);
}

export function areSimilarProposalIssues(a: ProposalIssueInput, b: ProposalIssueInput): boolean {
  const aTokens = proposalIssueTokens(a);
  const bTokens = proposalIssueTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return false;

  const shared = [...aTokens].filter((token) => bTokens.has(token));
  if (shared.length < MIN_PROPOSAL_SHARED_TOKENS) return false;

  const overlapRatio = shared.length / Math.min(aTokens.size, bTokens.size);
  if (overlapRatio < MIN_PROPOSAL_OVERLAP_RATIO) return false;

  const hasNamedAnchor = shared.some(
    (token) => /^[a-z][a-z0-9]{3,}$/.test(token) || /^[가-힣]{3,}$/.test(token),
  );
  const numericAnchors = shared.filter((token) => /^\d+$/.test(token)).length;
  return hasNamedAnchor || numericAnchors >= 2;
}

/**
 * Housekeeping proposals are noisy when generated proactively: they usually
 * reorganize existing reminders/calendar items instead of surfacing a new risk.
 * They may still be valid when the user explicitly asks, but the autonomous
 * agent should not create approval cards for them on its own.
 */
export function isHousekeepingProposalToolName(toolName: string | null | undefined): boolean {
  const normalized = (toolName || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!normalized) return false;

  return (
    normalized.startsWith("cleanup_") ||
    normalized.startsWith("clean_up_") ||
    normalized.includes("_cleanup_") ||
    normalized.endsWith("_cleanup") ||
    normalized.startsWith("reorganize_") ||
    normalized.startsWith("re_org_") ||
    normalized.startsWith("organize_") ||
    normalized.startsWith("tidy_") ||
    normalized.startsWith("declutter_") ||
    normalized.startsWith("dedupe_") ||
    normalized.startsWith("deduplicate_") ||
    normalized.startsWith("consolidate_") ||
    normalized.startsWith("prune_") ||
    normalized === "update_reminder" ||
    normalized === "update_reminders" ||
    normalized.includes("reminder_cleanup") ||
    normalized.includes("cleanup_reminder") ||
    normalized.includes("cleanup_reminders")
  );
}

function stringifyArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}
