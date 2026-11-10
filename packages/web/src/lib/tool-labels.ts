/**
 * Agent tool id → i18n key for a human label.
 *
 * Decision cards and the "always allowed tools" list used to show the raw
 * tool id ("send_email", or `toolName.replace(/_/g, " ")`), which is an
 * internal identifier, not copy. Callers pass the returned key through `t()`.
 * Unknown ids get a generic "Action" label rather than their raw id, so a new
 * server-side tool never leaks its name before it has a label here.
 *
 * Deliberately import-free: the web package has no unit-test runner, so this
 * is pinned from packages/api/src/__tests__/web-tool-labels.test.ts.
 */

export const KNOWN_TOOL_IDS = [
  "prepared_action",
  "send_email",
  "draft_reply",
  "reply_to_email",
  "archive_email",
  "delete_email",
  "mark_read",
  "create_event",
  "delete_event",
  "schedule_meeting",
  "create_contact",
  "update_contact",
  "delete_contact",
  "create_note",
  "delete_note",
  "create_task",
  "delete_task",
  "record_skill",
  "execute_skill",
  // Every other tool the agent can propose (ALL_TOOLS in the API's
  // autonomous-agent.ts): read-only today, labelled so none can ever surface
  // as a bare id.
  "list_emails",
  "read_email",
  "sender_context",
  "classify_emails",
  "list_events",
  "team_availability",
  "check_calendar_conflicts",
  "generate_briefing",
  "get_current_time",
  "get_upcoming_meetings",
  "join_meeting",
  "summarize_meeting",
  "calculate",
  "generate_password",
  "remember",
  "recall",
  "forget",
  "list_skills",
] as const;

export const UNKNOWN_TOOL_LABEL_KEY = "tool.label.unknown";

const KNOWN: ReadonlySet<string> = new Set(KNOWN_TOOL_IDS);

export function toolLabelKey(toolName: string | null | undefined): string {
  if (!toolName || !KNOWN.has(toolName)) return UNKNOWN_TOOL_LABEL_KEY;
  return `tool.label.${toolName}`;
}
