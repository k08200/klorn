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
 * Every query is scoped to `userId` (and nothing else picks rows). Full mail
 * text is read only when the user asked for it. The newest mails come first,
 * up to the limits in vault-limits.ts; when one is hit the export stops adding
 * mail notes, finishes the rest and says in _klorn.md that it is partial. A
 * mail whose note cannot be written (an unusable stored value) is left out and
 * counted there, instead of failing the whole stream.
 */

import { prisma } from "../db.js";
import { isJudgeV3PolicyEnabled } from "../judge/v3/flags.js";
import { extractEmailAddress } from "../mail/email-address.js";
import { reasonsForMail } from "../notify/notification-reason.js";
import { loadCommitments, senderNotes } from "./vault-export-lists.js";
import {
  type Emit,
  type ExportState,
  newExportState,
  type VaultExportInput,
  type VaultExportProgress,
} from "./vault-export-state.js";
import {
  ACTIVE_COMMITMENTS_PATH,
  countLanes,
  DONE_COMMITMENTS_PATH,
  INDEX_PATH,
  renderCommitmentsNote,
  renderLaneNote,
  renderVaultIndex,
  type VaultSummary,
} from "./vault-index-notes.js";
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
import { lanePath, renderMailNote, VAULT_LANES, type VaultMail } from "./vault-notes.js";
import { mailNotePath, senderKeyOf, senderNotePath } from "./vault-paths.js";

export {
  newVaultProgress,
  type VaultExportInput,
  type VaultExportProgress,
} from "./vault-export-state.js";

/** A mail ready to emit, with what later notes link by. */
interface PageEntry {
  mail: VaultMail;
  gmailId: string;
  threadId: string | null;
}

/** The archive, chunk by chunk: one local entry per note, then the central directory. */
export async function* vaultArchive(
  input: VaultExportInput,
  progress: VaultExportProgress,
): AsyncGenerator<Buffer> {
  const state = newExportState(input);
  const emit: Emit = (path, text) => {
    const chunk = state.zip.entry(path, text);
    progress.notes = state.zip.entryCount;
    progress.bytes = state.zip.bytesWritten;
    return chunk;
  };

  yield* mailNotes(state, emit);
  const senderCount = yield* senderNotes(state, emit);
  for (const lane of VAULT_LANES) {
    const refs = state.refs.filter((r) => r.lane === lane);
    yield emit(lanePath(lane), renderLaneNote(lane, refs));
  }
  const [active, done] = await loadCommitments(state);
  yield emit(ACTIVE_COMMITMENTS_PATH, renderCommitmentsNote("active", active));
  yield emit(DONE_COMMITMENTS_PATH, renderCommitmentsNote("done", done));
  const summary = summaryOf(state, senderCount, active.length, done.length);
  yield emit(INDEX_PATH, renderVaultIndex(summary));

  const { mails, commitments, senderTraits } = state.partial;
  progress.partial = Boolean(mails || commitments || senderTraits || state.skippedMails > 0);
  const end = state.zip.finish();
  progress.bytes = state.zip.bytesWritten;
  yield end;
}

/** The ids of the newest mails Klorn decided on, up to the count limit. */
async function pickMailIds(state: ExportState): Promise<string[]> {
  const { userId, limits } = state.input;
  const picked = await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL" },
    orderBy: [{ surfacedAt: "desc" }, { id: "desc" }],
    take: limits.maxMailNotes + 1,
    select: { sourceId: true },
  });
  if (picked.length > limits.maxMailNotes) state.partial.mails = "count";
  return picked.slice(0, limits.maxMailNotes).map((row) => row.sourceId);
}

async function* mailNotes(state: ExportState, emit: Emit): AsyncGenerator<Buffer> {
  const { limits } = state.input;
  const ids = await pickMailIds(state);
  for (let at = 0; at < ids.length; at += limits.pageSize) {
    // Work time only: a slow reader holds the stream, not the budget.
    if (state.workMs > limits.timeBudgetMs) {
      state.partial.mails = "time";
      return;
    }
    const started = Date.now();
    const page = await loadPage(state, ids.slice(at, at + limits.pageSize));
    const notes = page.map((entry) => ({ entry, note: renderMailNote(entry.mail) }));
    state.workMs += Date.now() - started;
    for (const { entry, note } of notes) {
      const size = Buffer.byteLength(note);
      if (state.mailBytes + size > limits.maxMailBytes) {
        state.partial.mails = "size";
        return;
      }
      state.mailBytes += size;
      yield emit(entry.mail.path, note);
      recordEmitted(state, entry);
    }
  }
}

/** Only an emitted note becomes a link target for the notes after it. */
function recordEmitted(state: ExportState, { mail, gmailId, threadId }: PageEntry): void {
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
  state.pathByGmailId.set(gmailId, mail.path);
  if (threadId && !state.pathByThread.has(threadId)) state.pathByThread.set(threadId, mail.path);
}

type PageRows = Awaited<ReturnType<typeof loadPageRows>>;

async function loadPageRows(state: ExportState, ids: string[]) {
  const { userId, includeBodies, language, now } = state.input;
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
  return { itemBy, mailBy, labelBy: new Map(labels.map((l) => [l.sourceId, l])), briefBy, reasons };
}

/** One page of mails, in `ids` order, ready to render. */
async function loadPage(state: ExportState, ids: string[]): Promise<PageEntry[]> {
  const rows = await loadPageRows(state, ids);
  return ids.flatMap((id) => {
    try {
      const entry = toEntry(state, rows, id);
      return entry ? [entry] : [];
    } catch (err) {
      // Counted and reported in _klorn.md; logged without any mail content.
      state.skippedMails += 1;
      console.warn(
        "[VAULT-EXPORT] left out a mail note:",
        err instanceof Error ? err.name : "unknown",
      );
      return [];
    }
  });
}

function toEntry(state: ExportState, rows: PageRows, id: string): PageEntry | null {
  const { includeBodies, timeZone, limits } = state.input;
  const mail = rows.mailBy.get(id);
  const item = rows.itemBy.get(id);
  if (!mail || !item) return null;
  const path = mailNotePath(
    { dateKey: localDate(mail.receivedAt, timeZone), subject: mail.subject, id: mail.id },
    state.paths,
  );
  const senderKey = senderKeyOf(mail.fromAddress ?? extractEmailAddress(mail.from));
  let brief: BriefRow | undefined;
  if (mail.threadId && !state.briefedThreads.has(mail.threadId)) {
    // Newest first: a thread's brief goes on its newest mail note.
    state.briefedThreads.add(mail.threadId);
    brief = rows.briefBy.get(mail.threadId);
  }
  const vaultMail = toVaultMail(
    { mail, item, label: rows.labelBy.get(id), brief, reason: rows.reasons.get(id) },
    {
      path,
      senderKey,
      senderPath: senderNotePath(senderKey, state.paths),
      timeZone,
      includeBodies,
      maxBodyChars: limits.maxBodyChars,
    },
  );
  return { mail: vaultMail, gmailId: mail.gmailId, threadId: mail.threadId };
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

function summaryOf(
  state: ExportState,
  senderCount: number,
  active: number,
  done: number,
): VaultSummary {
  return {
    exportedAt: isoWithOffset(state.input.now, state.input.timeZone),
    timeZone: state.input.timeZone,
    includesMailText: state.input.includeBodies,
    mailCount: state.refs.length,
    laneCounts: countLanes(state.refs),
    senderCount,
    activeCommitments: active,
    doneCommitments: done,
    partial: state.partial,
    skippedMails: state.skippedMails,
  };
}
