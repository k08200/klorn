/**
 * The mail note of the Klorn Vault export (Klorn/mail/YYYY/MM/...), plus the
 * frontmatter writer every note shares. Pure: the caller (vault-export.ts)
 * loads and shapes the rows; this only renders, escaping every value that
 * came from mail (vault-escape.ts).
 */

import type { LiveTier } from "@klorn/contract";
import { codeBlock, mdInline, wikiLink, yamlString } from "./vault-escape.js";

export const VAULT_LANES = [
  "PUSH",
  "MEETING",
  "QUEUE",
  "INFO",
  "SILENT",
] as const satisfies readonly LiveTier[];

export const NO_SUBJECT = "(no subject)";

/** What the user did with a mail, strongest first (vault-export.ts youAction). */
export const YOU_ACTIONS = [
  "replied",
  "archived",
  "unsubscribed",
  "dismissed",
  "snoozed",
  "starred",
  "opened",
] as const;
export type YouAction = (typeof YOU_ACTIONS)[number];

export interface VaultReason {
  text: string;
  /** True only when `quote` was found word for word in the mail (notify/notification-reason.ts). */
  verified: boolean;
  quote?: string;
  quoteIn?: "subject" | "body";
}

export interface VaultBrief {
  whyNow: string;
  asks: readonly string[];
  weOwe: string | null;
  theyOwe: string | null;
  stance: string | null;
}

export interface VaultMail {
  /** EmailMessage.id: the note's stable id. */
  id: string;
  path: string;
  subject: string;
  senderName: string;
  senderAddress: string;
  senderKey: string;
  senderPath: string;
  /** ISO 8601 with the user's offset. */
  received: string;
  dateKey: string;
  snippet: string | null;
  lane: LiveTier;
  reason: VaultReason | null;
  judgedBy: string;
  policy: string | null;
  status: string;
  laneFeedback: "override" | "confirm" | null;
  you: { action: YouAction; at: string } | null;
  brief: VaultBrief | null;
  /** Absent: the user did not ask for mail text. null: Klorn no longer keeps it. */
  body?: string | null;
}

/** What lane and sender notes list about a mail. */
export interface VaultMailRef {
  path: string;
  subject: string;
  dateKey: string;
  receivedMs: number;
  lane: LiveTier;
  senderKey: string;
  senderPath: string;
}

type FrontValue = string | number | boolean | readonly string[] | null | undefined;

/**
 * `---` frontmatter `---`. Keys are this file's constants; strings are
 * JSON-quoted (yamlString); null/undefined fields are left out.
 */
export function frontmatter(fields: ReadonlyArray<readonly [string, FrontValue]>): string {
  const lines = ["---"];
  for (const [key, value] of fields) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") lines.push(`${key}: ${yamlString(value)}`);
    else if (typeof value === "boolean") lines.push(`${key}: ${value}`);
    else if (typeof value === "number") lines.push(`${key}: ${Number.isFinite(value) ? value : 0}`);
    else lines.push(`${key}:`, ...value.map((item) => `  - ${yamlString(item)}`));
  }
  lines.push("---");
  return lines.join("\n");
}

export function laneTag(lane: LiveTier): string {
  return `klorn/${lane.toLowerCase()}`;
}

export function lanePath(lane: LiveTier): string {
  return `Klorn/lanes/${lane}.md`;
}

function reasonValue(reason: VaultReason | null): string | null {
  if (!reason) return null;
  return reason.verified && reason.quote ? reason.quote : reason.text;
}

function reasonLines(reason: VaultReason | null): string[] {
  if (!reason) return ["- **Why:** no reason recorded."];
  const check = reason.verified
    ? "checked word for word against the mail."
    : "Klorn's summary, not checked against the mail.";
  const lines = [`- **Why:** ${mdInline(reason.text)} — ${check}`];
  if (reason.verified && reason.quote) {
    lines.push(`- **Quote:** “${mdInline(reason.quote)}” (in the ${reason.quoteIn ?? "mail"})`);
  }
  return lines;
}

function briefLines(brief: VaultBrief | null): string[] {
  if (!brief) return [];
  const lines = ["", "## Thread brief", "", `- **Why now:** ${mdInline(brief.whyNow)}`];
  for (const ask of brief.asks) lines.push(`- **Ask:** ${mdInline(ask)}`);
  if (brief.weOwe) lines.push(`- **You owe:** ${mdInline(brief.weOwe)}`);
  if (brief.theyOwe) lines.push(`- **They owe:** ${mdInline(brief.theyOwe)}`);
  if (brief.stance) lines.push(`- **Suggested stance:** ${mdInline(brief.stance)}`);
  return lines;
}

function bodyLines(body: string | null | undefined): string[] {
  if (body === undefined) return [];
  if (body === null || body.trim() === "") {
    return ["", "## Mail text", "", "_Klorn no longer keeps the text of this mail._"];
  }
  return ["", "## Mail text", "", codeBlock(body)];
}

/** Klorn/mail/YYYY/MM/<date>-<slug>-<id>.md */
export function renderMailNote(mail: VaultMail): string {
  const subject = mail.subject.trim() || NO_SUBJECT;
  const from = wikiLink(mail.senderPath, mail.senderName || mail.senderKey);
  const head = frontmatter([
    ["klorn_id", mail.id],
    ["klorn_type", "mail"],
    ["subject", subject],
    ["from", from],
    ["from_address", mail.senderAddress],
    ["received", mail.received],
    ["lane", mail.lane],
    ["lane_reason", reasonValue(mail.reason)],
    ["lane_reason_verified", mail.reason ? mail.reason.verified : null],
    ["judged_by", mail.judgedBy],
    ["policy", mail.policy],
    ["status", mail.status],
    ["lane_feedback", mail.laneFeedback],
    ["you", mail.you?.action],
    ["you_at", mail.you?.at],
    ["tags", ["klorn/mail", laneTag(mail.lane)]],
  ]);
  const lines = [head, `# ${mdInline(subject)}`, ""];
  if (mail.snippet?.trim()) lines.push(`> ${mdInline(mail.snippet)}`, "");
  lines.push(`- **Lane:** ${wikiLink(lanePath(mail.lane), mail.lane)}`);
  lines.push(...reasonLines(mail.reason));
  lines.push(`- **From:** ${from} (${mdInline(mail.senderAddress)})`);
  lines.push(`- **Received:** ${mail.received}`);
  if (mail.you) lines.push(`- **You:** ${mail.you.action}, ${mail.you.at}`);
  lines.push(...briefLines(mail.brief), ...bodyLines(mail.body));
  return `${lines.join("\n")}\n`;
}
