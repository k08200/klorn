/**
 * Notification text helpers — turn internal tool names and raw email
 * metadata into messages a user actually wants to see on their phone.
 *
 * Rules of thumb:
 * - Title carries WHAT happened/needs to happen (3–5 words)
 * - Body carries WHO and any concrete next step
 * - No function names, no JSON payloads, no [internal_id] tags
 *
 * Copy lives in notification-strings.ts, keyed by language: this is Klorn's own
 * voice, so it follows the user's chosen language (a reply, by contrast,
 * follows the language of the mail it answers).
 */

import { extractEmailAddress } from "../mail/email-address.js";
import { notificationCopy } from "./notification-strings.js";

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
export function senderName(raw: string | null | undefined, language?: string | null): string {
  if (!raw) return notificationCopy(language).unknownSender;
  const match = raw.match(/^([^<]+?)\s*</);
  if (match?.[1]) return match[1].trim().slice(0, 30);
  return raw.replace(/[<>]/g, "").trim().slice(0, 30);
}

/**
 * Extract just the address portion (lowercased): "Name <a@b.com>" → "a@b.com".
 * Returns "" if no address is present — caller decides how to fall back.
 * Lowercase to match how ContactTrustScore.contactEmail is stored.
 */
export function senderEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  const address = extractEmailAddress(raw);
  return address.includes("@") ? address : "";
}

/** Map autonomous-agent tool calls to a clear user-facing summary. */
export function humanizeAutoExec(
  fnName: string,
  args: ToolArgs,
  language?: string | null,
): { autoTitle: string; autoMessage: string } {
  const copy = notificationCopy(language);
  const tool = copy.tools[fnName];
  if (tool) {
    return {
      autoTitle: `[Klorn] ${tool.title}`,
      autoMessage: tool.body({
        subject: truncate(args.subject, 40),
        to: senderName(args.to || args.recipient, language),
        title: truncate(args.title, 50),
        query: truncate(args.query, 60),
      }),
    };
  }
  // Unknown tool — at least drop the JSON dump.
  const friendly = fnName.replace(/_/g, " ");
  return {
    autoTitle: `[Klorn] ${copy.actionComplete.title}`,
    autoMessage: copy.actionComplete.body(friendly),
  };
}

/** Format urgent-email push body — no internal IDs, sender first. */
export function formatUrgentEmailBody(
  emails: Array<{ from: string | null; subject: string | null; summary?: string | null }>,
  language?: string | null,
): string {
  if (emails.length === 0) return "";
  const copy = notificationCopy(language);
  const top = emails[0];
  const who = senderName(top.from, language);
  const what = truncate(top.summary || top.subject || copy.newMail, 60);
  if (emails.length === 1) return `${who}: ${what}`;
  return copy.urgentDigest(emails.length, who, what);
}

function truncate(value: string | undefined | null, max: number): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
