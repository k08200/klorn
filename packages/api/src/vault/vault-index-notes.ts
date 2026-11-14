/**
 * The index notes of the Klorn Vault export: Klorn/_klorn.md (what this is and
 * how to read it), one note per lane, one per sender, and the two commitment
 * lists. Pure, like vault-notes.ts: every value from mail goes through
 * vault-escape.ts.
 */

import type { LiveTier } from "@klorn/contract";
import { mdInline, wikiLink } from "./vault-escape.js";
import {
  frontmatter,
  lanePath,
  NO_SUBJECT,
  VAULT_LANES,
  type VaultMailRef,
} from "./vault-notes.js";

export const VAULT_FORMAT_VERSION = 1;
export const INDEX_PATH = "Klorn/_klorn.md";
export const ACTIVE_COMMITMENTS_PATH = "Klorn/commitments/active.md";
export const DONE_COMMITMENTS_PATH = "Klorn/commitments/done.md";
/** A sender note lists at most this many mails; the lane notes list them all. */
export const SENDER_MAIL_LIST_MAX = 200;
const IN_TABLE = { inTable: true } as const;

/** Lane meanings (docs/product-vocabulary.md). A lane classifies; it never acts. */
const LANE_MEANING: Record<LiveTier, string> = {
  PUSH: "Needs you now: Klorn notifies you.",
  MEETING: "Scheduling mail: notifies like PUSH, with a calendar check.",
  QUEUE: "Worth reading today, without a notification. The default lane.",
  INFO: "Receipts, confirmations and status notices: filed, no reply expected.",
  SILENT: "Recorded and kept out of your way.",
};

export interface VaultTrait {
  address: string;
  kind: "relationship" | "recurring_intent";
  value: string;
  confidence: number;
  observedCount: number;
  status: string;
  evidence: string;
}

export interface VaultSender {
  key: string;
  path: string;
  mails: readonly VaultMailRef[];
  traits: readonly VaultTrait[];
}

export interface VaultCommitment {
  id: string;
  title: string;
  status: "OPEN" | "SNOOZED" | "DONE" | "DISMISSED";
  owner: "USER" | "COUNTERPARTY" | "TEAM" | "UNKNOWN";
  counterparty: string | null;
  counterpartyPath: string | null;
  /** YYYY-MM-DD in the user's zone. */
  due: string | null;
  dueText: string | null;
  sourcePath: string | null;
  sourceSubject: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  /** A low-confidence suggestion the user has not confirmed (pim/commitment-confirmation.ts). */
  suggested: boolean;
}

export type MailLimit = "count" | "size" | "time";

export interface VaultSummary {
  exportedAt: string;
  timeZone: string;
  includesMailText: boolean;
  mailCount: number;
  laneCounts: Record<LiveTier, number>;
  senderCount: number;
  activeCommitments: number;
  doneCommitments: number;
  partial: { mails: MailLimit | null; commitments: boolean; senderTraits: boolean };
  /** Mails whose note could not be written (an unusable stored value), left out. */
  skippedMails: number;
}

function newestFirst(refs: readonly VaultMailRef[]): VaultMailRef[] {
  return [...refs].sort((a, b) => b.receivedMs - a.receivedMs || a.path.localeCompare(b.path));
}

function mailLink(ref: VaultMailRef): string {
  return wikiLink(ref.path, ref.subject.trim() || NO_SUBJECT);
}

/** Klorn/lanes/<LANE>.md: every exported mail of the lane, newest first. */
export function renderLaneNote(lane: LiveTier, refs: readonly VaultMailRef[]): string {
  const head = frontmatter([
    ["klorn_type", "lane"],
    ["lane", lane],
    ["mails", refs.length],
    ["tags", ["klorn/lane"]],
  ]);
  const lines = [head, `# ${lane}`, "", LANE_MEANING[lane], ""];
  if (refs.length === 0) {
    lines.push("No mail in this lane in this export.");
  } else {
    lines.push(`${refs.length} mail${refs.length === 1 ? "" : "s"}, newest first.`, "");
    for (const ref of newestFirst(refs)) {
      lines.push(
        `- ${ref.dateKey} · ${mailLink(ref)} · ${wikiLink(ref.senderPath, ref.senderKey)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function countLanes(refs: readonly VaultMailRef[]): Record<LiveTier, number> {
  const counts = { PUSH: 0, MEETING: 0, QUEUE: 0, INFO: 0, SILENT: 0 };
  for (const ref of refs) counts[ref.lane] += 1;
  return counts;
}

function traitLines(traits: readonly VaultTrait[]): string[] {
  if (traits.length === 0) return [];
  const lines = ["", "## What Klorn learned", ""];
  for (const t of traits) {
    const status = t.status === "active" ? "" : ` · ${mdInline(t.status)}`;
    lines.push(
      `- ${mdInline(t.address)} · ${t.kind.replace("_", " ")}: ${mdInline(t.value)} · confidence ${t.confidence.toFixed(2)} · seen ${t.observedCount}×${status}`,
    );
    if (t.evidence.trim()) lines.push(`  - Evidence: “${mdInline(t.evidence)}”`);
  }
  return lines;
}

/** Klorn/senders/<key>.md: lane counts, what Klorn learned, newest mails. */
export function renderSenderNote(sender: VaultSender): string {
  const counts = countLanes(sender.mails);
  const relationships = [
    ...new Set(sender.traits.filter((t) => t.kind === "relationship").map((t) => t.value)),
  ];
  const head = frontmatter([
    ["klorn_type", "sender"],
    ["sender", sender.key],
    ["mails", sender.mails.length],
    ...VAULT_LANES.map((lane) => [lane.toLowerCase(), counts[lane]] as const),
    ["relationship", relationships.length > 0 ? relationships : null],
    ["tags", ["klorn/sender"]],
  ]);
  const lines = [head, `# ${mdInline(sender.key)}`, "", "| Lane | Mails |", "| --- | --- |"];
  for (const lane of VAULT_LANES)
    lines.push(`| ${wikiLink(lanePath(lane), lane, IN_TABLE)} | ${counts[lane]} |`);
  lines.push(...traitLines(sender.traits));
  if (sender.mails.length > 0) {
    lines.push("", "## Mails", "");
    const shown = newestFirst(sender.mails).slice(0, SENDER_MAIL_LIST_MAX);
    for (const ref of shown) lines.push(`- ${ref.dateKey} · ${ref.lane} · ${mailLink(ref)}`);
    const more = sender.mails.length - shown.length;
    if (more > 0) lines.push("", `${more} older mails are listed in the lane notes.`);
  }
  return `${lines.join("\n")}\n`;
}

const OWNER_LABEL: Record<VaultCommitment["owner"], string> = {
  USER: "you owe",
  COUNTERPARTY: "they owe",
  TEAM: "team owes",
  UNKNOWN: "owner unknown",
};

function commitmentLine(c: VaultCommitment, box: "[ ] " | "[x] " | ""): string {
  const parts = [`- ${box}${mdInline(c.title)}`, OWNER_LABEL[c.owner]];
  if (c.due) parts.push(`due ${c.due}`);
  else if (c.dueText) parts.push(`due “${mdInline(c.dueText)}” (as written)`);
  if (c.counterparty) {
    parts.push(
      `with ${c.counterpartyPath ? wikiLink(c.counterpartyPath, c.counterparty) : mdInline(c.counterparty)}`,
    );
  }
  if (c.sourcePath) parts.push(`from ${wikiLink(c.sourcePath, c.sourceSubject ?? NO_SUBJECT)}`);
  if (c.confirmedAt) parts.push(`confirmed ${c.confirmedAt}`);
  if (c.status === "DONE" && c.completedAt) parts.push(`done ${c.completedAt}`);
  if (c.status === "SNOOZED") parts.push("snoozed");
  const blockId =
    c.id
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "")
      .slice(0, 12) || "0";
  return `${parts.join(" · ")} ^c-${blockId}`;
}

/** Klorn/commitments/active.md (open, snoozed) or done.md (done, then dismissed). */
export function renderCommitmentsNote(
  list: "active" | "done",
  commitments: readonly VaultCommitment[],
): string {
  const head = frontmatter([
    ["klorn_type", "commitments"],
    ["list", list],
    ["count", commitments.length],
    ["tags", ["klorn/commitments"]],
  ]);
  const title = list === "active" ? "Active commitments" : "Done and dismissed commitments";
  const lines = [head, `# ${title}`, ""];
  if (commitments.length === 0) {
    lines.push("Nothing here in this export.");
    return `${lines.join("\n")}\n`;
  }
  if (list === "active") {
    const suggested = commitments.filter((c) => c.suggested);
    for (const c of commitments.filter((c) => !c.suggested)) lines.push(commitmentLine(c, "[ ] "));
    if (suggested.length > 0) {
      lines.push("", "## Suggested, not confirmed", "");
      lines.push("Klorn found these but you have not confirmed them.", "");
      for (const c of suggested) lines.push(commitmentLine(c, ""));
    }
    return `${lines.join("\n")}\n`;
  }
  const done = commitments.filter((c) => c.status === "DONE");
  const dismissed = commitments.filter((c) => c.status === "DISMISSED");
  for (const c of done) lines.push(commitmentLine(c, "[x] "));
  if (dismissed.length > 0) {
    lines.push("", "## Dismissed", "");
    for (const c of dismissed) lines.push(commitmentLine(c, ""));
  }
  return `${lines.join("\n")}\n`;
}

const MAIL_LIMIT_TEXT: Record<MailLimit, string> = {
  count: "it reached the most mails one export holds",
  size: "it reached the size one export can be",
  time: "it reached the time one export can take",
};

function isComplete(summary: VaultSummary): boolean {
  const { mails, commitments, senderTraits } = summary.partial;
  return !mails && !commitments && !senderTraits && summary.skippedMails === 0;
}

function partialLines(summary: VaultSummary): string[] {
  const { mails, commitments, senderTraits } = summary.partial;
  if (isComplete(summary)) return [];
  const lines = ["", "## This export is partial", ""];
  if (mails) {
    lines.push(
      `- Mail: the newest ${summary.mailCount} are here; older ones were left out because ${MAIL_LIMIT_TEXT[mails]}.`,
    );
  }
  if (summary.skippedMails > 0) {
    lines.push(`- Mail: ${summary.skippedMails} could not be written and were left out.`);
  }
  if (commitments) {
    lines.push("- Commitments: a list reached the most one export holds, so some were left out.");
  }
  if (senderTraits) lines.push("- Senders: some of what Klorn learned about senders was left out.");
  return lines;
}

const READING_GUIDE = [
  "## Reading a mail note",
  "",
  "One note per mail, in `Klorn/mail/YYYY/MM/`. `klorn_id` stays the same across exports. Its properties:",
  "",
  "- `lane`: the lane Klorn put the mail in.",
  "- `lane_reason`: why. With `lane_reason_verified: true` it is a quote checked word for word against the mail; otherwise it is Klorn's own summary, not checked.",
  "- `judged_by`: what decided the lane. `llm`, `fast-path`, `sender-prior` and `keyword-fallback` are Klorn's classifier paths; `you` means you moved it; `agent` means an agent you connected moved it; `klorn` means no path was recorded.",
  "- `policy`: the attention policy version, when one decided.",
  "- `status`: `open`, `resolved`, `dismissed` or `snoozed`.",
  "- `lane_feedback`: `override` when you moved the mail to another lane, `confirm` when you confirmed its lane.",
  "- `you` and `you_at`: the strongest thing you did with the mail that Klorn recorded: `replied`, `archived`, `unsubscribed`, `dismissed`, `snoozed`, `starred` or `opened`.",
];

/** Klorn/_klorn.md: what this folder is, the lane legend, how to read a note. */
export function renderVaultIndex(summary: VaultSummary): string {
  const complete = isComplete(summary);
  const head = frontmatter([
    ["klorn_type", "index"],
    ["klorn_vault_version", VAULT_FORMAT_VERSION],
    ["exported_at", summary.exportedAt],
    ["time_zone", summary.timeZone],
    ["mails", summary.mailCount],
    ["includes_mail_text", summary.includesMailText],
    ["complete", complete],
    ["tags", ["klorn"]],
  ]);
  const lanes = VAULT_LANES.map(
    (lane) =>
      `| ${wikiLink(lanePath(lane), lane, IN_TABLE)} | ${LANE_MEANING[lane]} | ${summary.laneCounts[lane]} |`,
  );
  const lines = [
    head,
    "# Klorn vault",
    "",
    `Your Klorn data as markdown, exported ${summary.exportedAt} (${mdInline(summary.timeZone)}). This is a snapshot: Klorn keeps the original, and editing these notes changes nothing in Klorn. Export again for a fresh copy.`,
    "",
    "## Lanes",
    "",
    "Klorn puts every mail in one of five lanes. A lane is how Klorn classified the mail; it never acts on the mail.",
    "",
    "| Lane | Meaning | Mails |",
    "| --- | --- | --- |",
    ...lanes,
    "",
    ...READING_GUIDE,
    "",
    summary.includesMailText
      ? "Full mail text is included where Klorn still keeps it."
      : "Full mail text is not included: a mail note holds the subject, the preview line and Klorn's decision, with any quote Klorn checked against the mail. Export again with mail text turned on to add the full text.",
    "",
    "## Also here",
    "",
    `- ${wikiLink(ACTIVE_COMMITMENTS_PATH, "Active commitments")} (${summary.activeCommitments}) and ${wikiLink(DONE_COMMITMENTS_PATH, "done or dismissed")} (${summary.doneCommitments}).`,
    `- \`Klorn/senders/\`: one note per sender (${summary.senderCount}), by organisation domain or, for public mail providers, by address, with lane counts and what Klorn learned about them.`,
    ...partialLines(summary),
  ];
  return `${lines.join("\n")}\n`;
}
