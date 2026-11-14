/**
 * Klorn Vault: the user's own Klorn data as an Obsidian-compatible markdown
 * zip, built as it streams (routes/vault-export.ts). Postgres stays the
 * source of truth; this is a read-only projection of it:
 *
 *   Klorn/_klorn.md                          what this is, lane legend, how to read
 *   Klorn/lanes/<LANE>.md                    the lane's mails, newest first
 *   Klorn/senders/<domain-or-address>.md     lane counts, sender traits, mails
 *   Klorn/commitments/active.md, done.md     with due, owner and source links
 *   Klorn/mail/YYYY/MM/<date>-<slug>-<id>.md one note per mail Klorn decided on
 *
 * Every query is scoped to `userId` (and nothing else picks rows). Mail text
 * is read only when the user asked for it. The newest mails come first, up to
 * the limits in vault-limits.ts; when one is hit the export stops adding mail
 * notes, finishes the rest and says in _klorn.md that it is partial.
 */

import type { CommitmentStatus, SenderTraitStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { isJudgeV3PolicyEnabled } from "../judge/v3/flags.js";
import { validateTraitValue } from "../learning/sender-trait-policy.js";
import { extractEmailAddress } from "../mail/email-address.js";
import { reasonsForMail } from "../notify/notification-reason.js";
import {
  ACTIVE_COMMITMENTS_PATH,
  DONE_COMMITMENTS_PATH,
  INDEX_PATH,
  renderCommitmentsNote,
  renderLaneNote,
  renderSenderNote,
  renderVaultIndex,
  type VaultCommitment,
  type VaultSummary,
  type VaultTrait,
} from "./vault-index-notes.js";
import type { VaultLimits } from "./vault-limits.js";
import {
  BRIEF_SELECT,
  type BriefRow,
  ITEM_SELECT,
  isoWithOffset,
  LABEL_SELECT,
  localDate,
  type MailRow,
  mailSelect,
  toVaultMail,
} from "./vault-mail-rows.js";
import { lanePath, renderMailNote, VAULT_LANES, type VaultMailRef } from "./vault-notes.js";
import { mailNotePath, PathRegistry, senderKeyOf, senderNotePath } from "./vault-paths.js";
import { ZipWriter } from "./zip-writer.js";

export interface VaultExportInput {
  userId: string;
  includeBodies: boolean;
  /** The reader's language, for lane reasons stored as keys. */
  language: string;
  timeZone: string;
  now: Date;
  limits: VaultLimits;
}

/** Updated as the archive streams; the route audits it when the stream ends. */
export interface VaultExportProgress {
  notes: number;
  bytes: number;
  partial: boolean;
}

interface ExportState {
  input: VaultExportInput;
  zip: ZipWriter;
  paths: PathRegistry;
  refs: VaultMailRef[];
  pathByGmailId: Map<string, string>;
  pathByThread: Map<string, string>;
  subjectByPath: Map<string, string>;
  briefedThreads: Set<string>;
  mailBytes: number;
  partial: VaultSummary["partial"];
}

const TRAIT_STATUSES: SenderTraitStatus[] = ["active", "conflicted"];
const ACTIVE_COMMITMENT_STATUSES: CommitmentStatus[] = ["OPEN", "SNOOZED"];
const DONE_COMMITMENT_STATUSES: CommitmentStatus[] = ["DONE", "DISMISSED"];

const COMMITMENT_SELECT = {
  id: true,
  title: true,
  status: true,
  owner: true,
  counterpartyName: true,
  counterpartyEmail: true,
  dueAt: true,
  dueText: true,
  sourceType: true,
  sourceId: true,
  threadId: true,
  confirmedAt: true,
  completedAt: true,
} as const;

export function newVaultProgress(): VaultExportProgress {
  return { notes: 0, bytes: 0, partial: false };
}

/** The archive, chunk by chunk: one local entry per note, then the central directory. */
export async function* vaultArchive(
  input: VaultExportInput,
  progress: VaultExportProgress,
): AsyncGenerator<Buffer> {
  const state: ExportState = {
    input,
    zip: new ZipWriter(input.now),
    paths: new PathRegistry(),
    refs: [],
    pathByGmailId: new Map(),
    pathByThread: new Map(),
    subjectByPath: new Map(),
    briefedThreads: new Set(),
    mailBytes: 0,
    partial: { mails: null, commitments: false, senderTraits: false },
  };
  const emit = (path: string, text: string): Buffer => {
    const chunk = state.zip.entry(path, text);
    progress.notes = state.zip.entryCount;
    progress.bytes = state.zip.bytesWritten;
    return chunk;
  };

  yield* mailNotes(state, emit);
  const senderCount = yield* senderNotes(state, emit);
  for (const lane of VAULT_LANES) {
    yield emit(
      lanePath(lane),
      renderLaneNote(
        lane,
        state.refs.filter((r) => r.lane === lane),
      ),
    );
  }
  const [active, done] = await loadCommitments(state);
  yield emit(ACTIVE_COMMITMENTS_PATH, renderCommitmentsNote("active", active));
  yield emit(DONE_COMMITMENTS_PATH, renderCommitmentsNote("done", done));
  yield emit(
    INDEX_PATH,
    renderVaultIndex(summaryOf(state, senderCount, active.length, done.length)),
  );

  progress.partial = Boolean(
    state.partial.mails || state.partial.commitments || state.partial.senderTraits,
  );
  const end = state.zip.finish();
  progress.bytes = state.zip.bytesWritten;
  yield end;
}

type Emit = (path: string, text: string) => Buffer;

async function* mailNotes(state: ExportState, emit: Emit): AsyncGenerator<Buffer> {
  const { userId, limits } = state.input;
  const picked = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL" },
    orderBy: [{ surfacedAt: "desc" }, { id: "desc" }],
    take: limits.maxMailNotes + 1,
    select: { sourceId: true },
  });
  if (picked.length > limits.maxMailNotes) state.partial.mails = "count";
  const ids = picked.slice(0, limits.maxMailNotes).map((row) => row.sourceId);
  const deadline = Date.now() + limits.timeBudgetMs;

  for (let at = 0; at < ids.length; at += limits.pageSize) {
    if (Date.now() > deadline) {
      state.partial.mails = "time";
      return;
    }
    for (const mail of await loadPage(state, ids.slice(at, at + limits.pageSize))) {
      const note = renderMailNote(mail);
      const size = Buffer.byteLength(note);
      if (state.mailBytes + size > limits.maxMailBytes) {
        state.partial.mails = "size";
        return;
      }
      state.mailBytes += size;
      yield emit(mail.path, note);
      state.refs.push({
        path: mail.path,
        subject: mail.subject,
        dateKey: mail.dateKey,
        receivedMs: Date.parse(mail.received),
        lane: mail.lane,
        senderKey: mail.senderKey,
        senderPath: mail.senderPath,
      });
      state.subjectByPath.set(mail.path, mail.subject);
    }
  }
}

/** One page of mails, in `ids` order, as notes ready to render. */
async function loadPage(state: ExportState, ids: string[]) {
  const { userId, includeBodies, language, now, timeZone, limits } = state.input;
  const [items, mails, labels] = await Promise.all([
    prisma.attentionItem.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: ids } },
      select: ITEM_SELECT,
    }),
    prisma.emailMessage.findMany({
      where: { userId, id: { in: ids } },
      select: mailSelect(includeBodies),
    }) as Promise<MailRow[]>,
    prisma.decisionLabel.findMany({
      where: { userId, source: "EMAIL", sourceId: { in: ids } },
      select: LABEL_SELECT,
    }),
  ]);
  const itemBy = new Map(items.map((item) => [item.sourceId, item]));
  const mailBy = new Map(mails.filter((m) => itemBy.has(m.id)).map((m) => [m.id, m]));
  const labelBy = new Map(labels.map((label) => [label.sourceId, label]));
  const briefBy = await loadBriefs(state, [...mailBy.values()]);
  const reasons = await reasonsForMail(
    userId,
    [...mailBy.values()].map((m) => ({
      id: m.id,
      subject: m.subject,
      ...(includeBodies ? { body: m.body ?? null, snippet: m.snippet } : {}),
    })),
    itemBy,
    { language, now, policyUser: isJudgeV3PolicyEnabled(userId) },
  );

  return ids.flatMap((id) => {
    const mail = mailBy.get(id);
    const item = itemBy.get(id);
    if (!mail || !item) return [];
    const senderKey = senderKeyOf(mail.fromAddress ?? extractEmailAddress(mail.from));
    const path = mailNotePath(
      { dateKey: localDate(mail.receivedAt, timeZone), subject: mail.subject, id: mail.id },
      state.paths,
    );
    state.pathByGmailId.set(mail.gmailId, path);
    let brief: BriefRow | undefined;
    if (mail.threadId && !state.briefedThreads.has(mail.threadId)) {
      // Newest first: the thread's brief goes on its newest mail note.
      state.briefedThreads.add(mail.threadId);
      state.pathByThread.set(mail.threadId, path);
      brief = briefBy.get(mail.threadId);
    }
    return [
      toVaultMail(
        { mail, item, label: labelBy.get(id), brief, reason: reasons.get(id) },
        {
          path,
          senderKey,
          senderPath: senderNotePath(senderKey, state.paths),
          timeZone,
          includeBodies,
          maxBodyChars: limits.maxBodyChars,
        },
      ),
    ];
  });
}

async function loadBriefs(state: ExportState, mails: MailRow[]): Promise<Map<string, BriefRow>> {
  const threadIds = [
    ...new Set(
      mails.flatMap((m) =>
        m.threadId && !state.briefedThreads.has(m.threadId) ? [m.threadId] : [],
      ),
    ),
  ];
  if (threadIds.length === 0) return new Map();
  const rows = await prisma.threadBrief.findMany({
    where: { userId: state.input.userId, threadId: { in: threadIds } },
    select: BRIEF_SELECT,
  });
  return new Map(rows.map((row) => [row.threadId, row]));
}

/** One note per sender of an exported mail or with something Klorn learned. */
async function* senderNotes(state: ExportState, emit: Emit): AsyncGenerator<Buffer, number> {
  const { userId, limits } = state.input;
  const rows = await prisma.senderTrait.findMany({
    where: { userId, status: { in: TRAIT_STATUSES } },
    orderBy: { lastSeenAt: "desc" },
    take: limits.maxSenderTraits + 1,
    select: {
      sender: true,
      factKind: true,
      factValue: true,
      confidence: true,
      observedCount: true,
      evidenceText: true,
      status: true,
    },
  });
  if (rows.length > limits.maxSenderTraits) state.partial.senderTraits = true;
  const traitsBy = new Map<string, VaultTrait[]>();
  for (const row of rows.slice(0, limits.maxSenderTraits)) {
    const value = validateTraitValue(row.factKind, row.factValue);
    if (!value) continue;
    const key = senderKeyOf(row.sender);
    const trait: VaultTrait = {
      address: row.sender,
      kind: row.factKind,
      value,
      confidence: row.confidence,
      observedCount: row.observedCount,
      status: row.status,
      evidence: row.evidenceText,
    };
    appendTo(traitsBy, key, trait);
  }
  const refsBy = new Map<string, VaultMailRef[]>();
  for (const ref of state.refs) appendTo(refsBy, ref.senderKey, ref);

  const keys = [...new Set([...refsBy.keys(), ...traitsBy.keys()])].sort();
  for (const key of keys) {
    const path = senderNotePath(key, state.paths);
    yield emit(
      path,
      renderSenderNote({
        key,
        path,
        mails: refsBy.get(key) ?? [],
        traits: traitsBy.get(key) ?? [],
      }),
    );
  }
  return keys.length;
}

/** Groups into a map this function owns (local accumulator; linear, not copy-per-row). */
function appendTo<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const list = groups.get(key);
  if (list) list.push(value);
  else groups.set(key, [value]);
}

async function loadCommitments(
  state: ExportState,
): Promise<[VaultCommitment[], VaultCommitment[]]> {
  const { userId, limits } = state.input;
  const [active, done] = await Promise.all([
    prisma.commitment.findMany({
      where: { userId, status: { in: ACTIVE_COMMITMENT_STATUSES } },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: limits.maxCommitments + 1,
      select: COMMITMENT_SELECT,
    }),
    prisma.commitment.findMany({
      where: { userId, status: { in: DONE_COMMITMENT_STATUSES } },
      orderBy: [{ updatedAt: "desc" }],
      take: limits.maxCommitments + 1,
      select: COMMITMENT_SELECT,
    }),
  ]);
  if (active.length > limits.maxCommitments || done.length > limits.maxCommitments) {
    state.partial.commitments = true;
  }
  const shape = (rows: typeof active) =>
    rows.slice(0, limits.maxCommitments).map((c) => toCommitment(state, c));
  return [shape(active), shape(done)];
}

type CommitmentRow = Awaited<
  ReturnType<typeof prisma.commitment.findMany<{ select: typeof COMMITMENT_SELECT }>>
>[number];

function toCommitment(state: ExportState, c: CommitmentRow): VaultCommitment {
  const { timeZone } = state.input;
  const fromMail = c.sourceType === "EMAIL";
  const sourcePath =
    (fromMail && c.sourceId ? state.pathByGmailId.get(c.sourceId) : undefined) ??
    (fromMail && c.threadId ? state.pathByThread.get(c.threadId) : undefined) ??
    null;
  const email = c.counterpartyEmail?.trim() || null;
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    owner: c.owner,
    counterparty: c.counterpartyName?.trim() || email,
    counterpartyPath: email ? (state.paths.keyed(senderKeyOf(email)) ?? null) : null,
    due: c.dueAt ? localDate(c.dueAt, timeZone) : null,
    dueText: c.dueText,
    sourcePath,
    sourceSubject: sourcePath ? (state.subjectByPath.get(sourcePath) ?? null) : null,
    confirmedAt: c.confirmedAt ? localDate(c.confirmedAt, timeZone) : null,
    completedAt: c.completedAt ? localDate(c.completedAt, timeZone) : null,
  };
}

function summaryOf(
  state: ExportState,
  senderCount: number,
  active: number,
  done: number,
): VaultSummary {
  const laneCounts = { PUSH: 0, MEETING: 0, QUEUE: 0, INFO: 0, SILENT: 0 };
  for (const ref of state.refs) laneCounts[ref.lane] += 1;
  return {
    exportedAt: isoWithOffset(state.input.now, state.input.timeZone),
    timeZone: state.input.timeZone,
    includesMailText: state.input.includeBodies,
    mailCount: state.refs.length,
    laneCounts,
    senderCount,
    activeCommitments: active,
    doneCommitments: done,
    partial: state.partial,
  };
}
