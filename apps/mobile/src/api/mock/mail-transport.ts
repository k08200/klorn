/**
 * Mail routes of the mock API. Stateful for one page load (a Done row, a lane
 * move, an unsubscribe stay done while the demo runs), so screenshots and the
 * Playwright behaviour specs see the same consequences the server would give.
 *
 * Scenarios `flagsOff` and `featuresOff` answer the dark routes the way
 * production does while their flags are off (Fastify's bare 404):
 * reader-context (MAIL_V2), the by-email lane move + undo (KEYBOARD_TRIAGE),
 * subscriptions (BULK_UNSUBSCRIBE_ENABLED).
 */
import type { LiveTier } from "@klorn/contract";
import { MOCK_INBOXES } from "./fixtures";
import {
  listItem,
  type MailRow,
  mailRows,
  mockMailDetail,
  mockReaderContext,
  mockReplyDraft,
  mockSenderDossier,
  mockSubscriptions,
  mockThreadBrief,
} from "./mail-fixtures";

const PAGE_SIZE = 20;
const LIVE: readonly string[] = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"];

export interface MailMockState {
  tiers: Map<string, LiveTier>;
  undo: Map<string, { emailId: string; previous: LiveTier | null; token: string }>;
  dismissed: Set<string>;
  snoozed: Map<string, string>;
  pins: Array<{ emailId: string; tier: string }>;
  read: Set<string>;
  unsubscribed: Set<string>;
  /** `from` = the linked inbox id a new mail was sent from (absent = primary). */
  sent: Array<{ to: string; subject: string; body: string; from?: string }>;
}

export function createMailMockState(): MailMockState {
  return {
    tiers: new Map(),
    undo: new Map(),
    dismissed: new Set(),
    snoozed: new Map(),
    pins: [],
    read: new Set(),
    unsubscribed: new Set(),
    sent: [],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fastify's own 404 for a dark route — no `code`, no "not found" of a record. */
function darkRoute(method: string, pathname: string): Response {
  return json(404, {
    message: `Route ${method}:${pathname} not found`,
    error: "Not Found",
    statusCode: 404,
  });
}

/** The server receipt of a send (contract SendReceiptWire), for `?scenario=sendReceipts`. */
function mockReceipt(n: number, now: number) {
  return {
    id: `rcpt-mock-${n}`,
    v: "v1",
    action: "send_email",
    // Not a real hash of the bytes — the app shows the server's value as is.
    payloadHash: "5e7c0a3f9b21d4c8e6f0a1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7",
    approvedAt: new Date(now).toISOString(),
  };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  try {
    return JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface MailMockContext {
  pathname: string;
  searchParams: URLSearchParams;
  method: string;
  init: RequestInit;
  now: number;
  scenario: string;
  state: MailMockState;
}

/** Answers a mail route, or returns null so the caller tries its own routes. */
export function mockMailRoute(ctx: MailMockContext): Response | null {
  const { pathname, searchParams, method, init, now, scenario, state } = ctx;
  const flagsOff = scenario === "flagsOff" || scenario === "featuresOff";
  const empty = scenario === "empty" || scenario === "noAccounts";
  const rows = empty ? [] : mailRows(now);
  const tierOf = (row: MailRow): LiveTier | null => state.tiers.get(row.id) ?? row.tier;
  const find = (id: string) => rows.find((r) => r.id === id || `g-${r.id}` === id);
  // A classified mail has one attention item; the board's fixtures name theirs
  // `att-…` (fixtures.ts), the rest get `att-<email id>`.
  const itemIdOf = (row: MailRow): string | null =>
    row.tier === null
      ? null
      : row.id.startsWith("email-att-")
        ? row.id.slice("email-".length)
        : `att-${row.id}`;
  /** Done, or a Later still ahead — what `hideHandled=1` leaves out (judge/email-lanes.ts). */
  const handled = (row: MailRow): boolean => {
    const itemId = itemIdOf(row);
    if (!itemId) return false;
    const until = state.snoozed.get(itemId);
    return state.dismissed.has(itemId) || (until !== undefined && Date.parse(until) > now);
  };

  // ── List ───────────────────────────────────────────────────────────────
  if (pathname === "/api/email" && method === "GET") {
    const tier = searchParams.get("tier");
    const inbox = searchParams.get("inbox");
    const search = searchParams.get("search")?.trim().toLowerCase() ?? "";
    const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
    const hideHandled = ["1", "true"].includes(searchParams.get("hideHandled") ?? "");
    const filtered = rows.filter((row) => {
      if (hideHandled && handled(row)) return false;
      if (tier && tier !== "ALL") {
        const lane = tierOf(row) ?? "QUEUE";
        if (lane !== tier) return false;
      }
      if (inbox === "primary" && row.inbox !== null) return false;
      if (inbox && inbox !== "primary" && row.inbox !== inbox) return false;
      if (search) {
        const hay = `${row.subject} ${row.from} ${row.summary}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return json(200, {
      emails: slice.map((row) => ({
        ...listItem(now, row),
        tier: tierOf(row),
        ...(state.read.has(row.id) ? { isRead: true } : {}),
      })),
      source: "gmail",
      total: filtered.length,
      unread: rows.filter((r) => r.unread).length,
      page,
      ...(scenario === "noAccounts" ? { needsConnection: true } : {}),
    });
  }

  // ── Subscriptions ──────────────────────────────────────────────────────
  if (pathname === "/api/email/subscriptions" && method === "GET") {
    if (flagsOff) return darkRoute(method, pathname);
    return json(200, {
      subscriptions: empty
        ? []
        : mockSubscriptions(now).filter(
            (s) => !state.unsubscribed.has(`${s.linkedInboxAccountId ?? ""}:${s.sender}`),
          ),
      windowDays: 90,
    });
  }
  if (pathname === "/api/email/subscriptions/unsubscribe" && method === "POST") {
    if (flagsOff) return darkRoute(method, pathname);
    const body = bodyOf(init);
    const sub = mockSubscriptions(now).find(
      (s) =>
        s.sender === body.sender && s.linkedInboxAccountId === (body.linkedInboxAccountId ?? null),
    );
    if (!sub) return json(404, { error: "Subscription not found" });
    const archived = body.archive === true ? Math.min(sub.count, 100) : 0;
    if (sub.method === "link") {
      return json(200, {
        method: "link",
        done: false,
        url: `https://${sub.sender.split("@")[1]}/unsubscribe`,
        archived,
        archiveFailed: 0,
      });
    }
    state.unsubscribed.add(`${sub.linkedInboxAccountId ?? ""}:${sub.sender}`);
    return json(200, { method: sub.method, done: true, archived, archiveFailed: 0 });
  }

  if (pathname === "/api/email/sync" && method === "POST") {
    return json(200, { synced: rows.length, newCount: 0 });
  }
  if (pathname === "/api/email/send" && method === "POST") {
    const body = bodyOf(init);
    if (!body.to || !body.subject || !body.body) {
      return json(400, { error: "Missing required fields: to, subject, body" });
    }
    // routes/email-mutations.ts resolveSendInbox: absent / null / "primary" =
    // the primary inbox; else one of the caller's linked inboxes, or 404.
    const from = body.linkedInboxAccountId;
    const account = from === undefined || from === null || from === "primary" ? null : from;
    if (account !== null && typeof account !== "string") {
      return json(400, { error: "linkedInboxAccountId must be a linked inbox id." });
    }
    const linked = account ? MOCK_INBOXES.inboxes.find((i) => i.id === account) : null;
    if (account && !linked) return json(404, { error: "Linked inbox not found" });
    if (linked && (linked.provider === "NAVER" || linked.provider === "ICLOUD")) {
      // IMAP_SEND_ENABLED off: the provider has no send surface.
      return json(501, { error: "Sending is not supported for this mailbox yet." });
    }
    state.sent.push({
      to: String(body.to),
      subject: String(body.subject),
      body: String(body.body),
      ...(account ? { from: account } : {}),
    });
    return json(200, {
      success: true,
      messageId: `msg-${state.sent.length}`,
      threadId: null,
      ...(scenario === "sendReceipts" ? { receipt: mockReceipt(state.sent.length, now) } : {}),
    });
  }

  // ── One mail ───────────────────────────────────────────────────────────
  const one = pathname.match(/^\/api\/email\/([^/]+)(?:\/(.+))?$/);
  if (one?.[1]) {
    const id = decodeURIComponent(one[1]);
    const rest = one[2] ?? "";
    const row = find(id);
    if (!row) {
      if (["lane-counts", "inboxes", "sync"].includes(id)) return null;
      return json(404, { error: "Email not found" });
    }
    if (rest === "" && method === "GET") {
      const detail = mockMailDetail(now, row);
      return json(200, {
        ...detail,
        isRead: detail.isRead || state.read.has(row.id),
        tier: tierOf(row),
      });
    }
    if (rest === "read" && method === "PATCH") {
      if (bodyOf(init).isRead === false) state.read.delete(row.id);
      else state.read.add(row.id);
      return json(200, { success: true });
    }
    if (rest === "reader-context" && method === "GET") {
      if (flagsOff) return darkRoute(method, pathname);
      const tier = searchParams.get("tier");
      const view = rows.filter((r) => !tier || tier === "ALL" || (tierOf(r) ?? "QUEUE") === tier);
      const inView = view.some((r) => r.id === row.id) ? view : rows;
      return json(200, mockReaderContext(inView, row.id, tierOf));
    }
    if (rest === "thread-brief" && method === "GET") {
      return json(200, { brief: mockThreadBrief(row.id) });
    }
    if (rest === "sender-dossier" && method === "GET") {
      return json(200, mockSenderDossier(row.id));
    }
    if (/^attachments\/[^/]+\/download$/.test(rest) && method === "GET") {
      return new Response("%PDF-1.4\n% mock\n", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (rest === "reply-draft" && method === "POST") {
      if (scenario === "draftUnavailable") {
        return json(503, { error: "Reply drafting is temporarily unavailable (timeout)." });
      }
      return json(200, mockReplyDraft(row, bodyOf(init).intent as string | undefined));
    }
    if (rest === "reply" && method === "POST") {
      const body = bodyOf(init);
      if (typeof body.body !== "string" || !body.body.trim()) {
        return json(400, { error: "Missing required field: body" });
      }
      const draft = mockReplyDraft(row, undefined);
      state.sent.push({ to: draft.to, subject: draft.subject, body: body.body });
      return json(200, {
        success: true,
        messageId: `msg-${state.sent.length}`,
        threadId: `t-${row.id}`,
        to: draft.to,
        threaded: true,
        ...(scenario === "sendReceipts" ? { receipt: mockReceipt(state.sent.length, now) } : {}),
      });
    }
    if (rest === "gmail-draft" && method === "POST") {
      return json(200, { success: true, draftId: `draft-${row.id}` });
    }
    if (rest === "pin-tier") {
      const sender = /<([^>]+)>/.exec(row.from)?.[1] ?? row.from;
      if (method === "DELETE") return json(200, { pinned: false, sender });
      const tier = String(bodyOf(init).tier ?? "");
      if (!LIVE.includes(tier)) return json(400, { error: "tier must be one of the known lanes." });
      state.pins.push({ emailId: row.id, tier });
      return json(200, { pinned: true, sender, tier });
    }
  }

  // ── Triage (routes/firewall.ts) ────────────────────────────────────────
  const byEmail = pathname.match(/^\/api\/inbox\/firewall\/email\/([^/]+)$/);
  if (byEmail?.[1] && method === "POST") {
    if (flagsOff) return darkRoute(method, pathname);
    const row = find(decodeURIComponent(byEmail[1]));
    const tier = String(bodyOf(init).tier ?? "");
    if (!LIVE.includes(tier)) return json(400, { error: "tier must be a live lane" });
    if (!row || row.tier === null) {
      return json(404, {
        ok: false,
        code: "not_found",
        message: "This mail has not been classified yet.",
      });
    }
    const itemId = `att-${row.id}`;
    const token = `undo-${itemId}-${Date.now()}`;
    state.undo.set(itemId, { emailId: row.id, previous: tierOf(row), token });
    state.tiers.set(row.id, tier as LiveTier);
    return json(200, {
      ok: true,
      tier,
      itemId,
      undoToken: token,
      undoExpiresAt: new Date(now + 10 * 60_000).toISOString(),
    });
  }
  const undo = pathname.match(/^\/api\/inbox\/firewall\/([^/]+)\/undo$/);
  if (undo?.[1] && method === "POST") {
    if (flagsOff) return darkRoute(method, pathname);
    const entry = state.undo.get(decodeURIComponent(undo[1]));
    if (!entry || entry.token !== bodyOf(init).undoToken) {
      return json(409, { ok: false, code: "undo_expired", message: "Too late to undo." });
    }
    state.undo.delete(decodeURIComponent(undo[1]));
    if (entry.previous) state.tiers.set(entry.emailId, entry.previous);
    else state.tiers.delete(entry.emailId);
    return json(200, { ok: true, tier: entry.previous, alreadyUndone: false });
  }
  // Done / Later by email id (judge/attention-by-email.ts): any of the caller's
  // mail; `alreadyClear` when nothing was open to clear, and nothing is created.
  const actByEmail = pathname.match(/^\/api\/inbox\/firewall\/email\/([^/]+)\/(dismiss|snooze)$/);
  if (actByEmail?.[1] && method === "POST") {
    const row = find(decodeURIComponent(actByEmail[1]));
    if (!row) return json(404, { ok: false, code: "not_found", message: "Email not found." });
    let until: Date | null = null;
    if (actByEmail[2] === "snooze") {
      until = new Date(String(bodyOf(init).snoozeUntil ?? ""));
      if (!Number.isFinite(until.getTime()) || until.getTime() <= now) {
        return json(400, {
          ok: false,
          code: "invalid_snooze_until",
          message: "snoozeUntil must be a future ISO datetime.",
        });
      }
    }
    const itemId = itemIdOf(row);
    if (!itemId || state.dismissed.has(itemId)) {
      return json(200, { ok: true, itemId, alreadyClear: true });
    }
    if (until) {
      state.snoozed.set(itemId, until.toISOString());
      return json(200, {
        ok: true,
        itemId,
        alreadyClear: false,
        snoozedUntil: until.toISOString(),
      });
    }
    state.snoozed.delete(itemId);
    state.dismissed.add(itemId);
    return json(200, { ok: true, itemId, alreadyClear: false });
  }
  const act = pathname.match(/^\/api\/inbox\/firewall\/([^/]+)\/(dismiss|snooze)$/);
  if (act?.[1] && method === "POST") {
    if (act[2] === "snooze") {
      const until = new Date(String(bodyOf(init).snoozeUntil ?? ""));
      if (!Number.isFinite(until.getTime()) || until.getTime() <= now) {
        return json(400, { ok: false, message: "snoozeUntil must be a future ISO datetime." });
      }
      state.snoozed.set(decodeURIComponent(act[1]), until.toISOString());
      return json(200, { ok: true, snoozedUntil: until.toISOString() });
    }
    state.dismissed.add(decodeURIComponent(act[1]));
    return json(200, { ok: true });
  }
  const legacy = pathname.match(/^\/api\/inbox\/firewall\/([^/]+)$/);
  if (legacy?.[1] && legacy[1] !== "graph" && method === "POST") {
    const tier = String(bodyOf(init).tier ?? "");
    const emailId = decodeURIComponent(legacy[1]).replace(/^att-/, "email-att-");
    if (find(emailId) && LIVE.includes(tier)) state.tiers.set(emailId, tier as LiveTier);
    return json(200, { ok: true, tier });
  }
  return null;
}
