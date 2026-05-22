/**
 * Notification text helpers — turn internal tool names and raw email
 * metadata into messages a user actually wants to see on their phone.
 *
 * Rules of thumb:
 * - Title carries WHAT happened/needs to happen (3–5 words)
 * - Body carries WHO and any concrete next step
 * - No function names, no JSON payloads, no [internal_id] tags
 */

interface ToolArgs {
  to?: string;
  recipient?: string;
  subject?: string;
  title?: string;
  message?: string;
  query?: string;
  task_id?: string;
  taskId?: string;
  event_id?: string;
  eventId?: string;
  [key: string]: unknown;
}

/** Strip "Display Name <a@b.com>" → "Display Name", or just trim email. */
export function senderName(raw: string | null | undefined): string {
  if (!raw) return "Unknown sender";
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim().slice(0, 30);
  return raw.replace(/[<>]/g, "").trim().slice(0, 30);
}

/** Map autonomous-agent tool calls to a clear user-facing summary. */
export function humanizeAutoExec(
  fnName: string,
  args: ToolArgs,
): { autoTitle: string; autoMessage: string } {
  const summary = TOOL_SUMMARIES[fnName];
  if (summary) {
    const built = summary(args);
    return { autoTitle: `[Klorn] ${built.title}`, autoMessage: built.body };
  }
  // Unknown tool — at least drop the JSON dump.
  const friendly = fnName.replace(/_/g, " ");
  return {
    autoTitle: "[Klorn] Action complete",
    autoMessage: `${friendly} finished.`,
  };
}

type Summary = (args: ToolArgs) => { title: string; body: string };

const TOOL_SUMMARIES: Record<string, Summary> = {
  send_email: (a) => ({
    title: "Email sent",
    body: `Sent "${truncate(a.subject, 40)}" to ${senderName(a.to || a.recipient)}.`,
  }),
  draft_email: (a) => ({
    title: "Draft ready",
    body: `Prepared a draft for ${senderName(a.to || a.recipient)}. Review it before sending.`,
  }),
  classify_emails: () => ({
    title: "Mail prioritized",
    body: "Inbox priority has been refreshed.",
  }),
  trash_email: (a) => ({
    title: "Mail cleaned up",
    body: `Moved ${a.subject ? `"${truncate(a.subject, 30)}" ` : "a low-priority message "}to trash.`,
  }),
  create_task: (a) => ({
    title: "Task added",
    body: `Added "${truncate(a.title, 50)}" to tasks.`,
  }),
  update_task: () => ({ title: "Task updated", body: "Task status was updated." }),
  complete_task: (a) => ({
    title: "Task complete",
    body: a.title ? `Completed "${truncate(a.title, 50)}".` : "Completed a task.",
  }),
  create_reminder: (a) => ({
    title: "Reminder set",
    body: `A reminder is set for "${truncate(a.title, 50)}".`,
  }),
  create_event: (a) => ({
    title: "Calendar event added",
    body: `Added "${truncate(a.title, 50)}" to the calendar.`,
  }),
  create_note: (a) => ({
    title: "Note saved",
    body: `Saved note "${truncate(a.title, 50)}".`,
  }),
  update_note: () => ({ title: "Note updated", body: "The note was updated." }),
  search_web: (a) => ({
    title: "Web search complete",
    body: a.query ? `Searched "${truncate(a.query, 60)}".` : "Web search is complete.",
  }),
};

/** Format urgent-email push body — no internal IDs, sender first. */
export function formatUrgentEmailBody(
  emails: Array<{ from: string | null; subject: string | null; summary?: string | null }>,
): string {
  if (emails.length === 0) return "";
  const top = emails[0];
  const who = senderName(top.from);
  const what = truncate(top.summary || top.subject || "New mail", 60);
  if (emails.length === 1) return `${who}: ${what}`;
  return `${emails.length} urgent emails. Latest: ${who} - ${what}`;
}

function truncate(value: string | undefined | null, max: number): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
