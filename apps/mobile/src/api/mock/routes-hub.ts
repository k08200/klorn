/**
 * The mock API for Calendar, Assistant, Files, Accounts, Settings, Push and
 * Plans. The writes change an in-memory state (reset on reload), so a mock
 * session behaves like the real one: an approved card leaves, a created event
 * shows in the agenda, a disconnected account is gone.
 *
 * Scenario `featuresOff` answers every flag-gated route the way production
 * does with its default flags: the drive, Google Drive, Outlook, iCloud,
 * generic IMAP and CalDAV routes 404, and /api/teams 403 TEAM_REQUIRED.
 */
import type {
  CalendarEventWire,
  ChatMessageWire,
  EventDraftWire,
  PendingActionWire,
} from "../wire";
import { mockPendingActions } from "./fixtures";
import {
  eventsInRange,
  MOCK_BILLING,
  MOCK_CONVERSATION,
  MOCK_DRIVE_FILES,
  MOCK_DRIVE_LIMITS,
  MOCK_DRIVE_SUMMARIES,
  MOCK_GOOGLE_DRIVE_ACCOUNTS,
  MOCK_LINKED_CALENDARS,
  MOCK_NOTIFICATION_SETTINGS,
  MOCK_TEAMS,
  mockAttachmentDetail,
  mockAttachmentList,
  mockChatMessages,
  mockImapStatus,
  mockReceipt,
  mockTeamAvailability,
  mockWeekEvents,
} from "./fixtures-hub";

export interface HubRequest {
  pathname: string;
  searchParams: URLSearchParams;
  method: string;
  body: unknown;
  scenario: string;
  now: number;
}

interface HubState {
  created: CalendarEventWire[];
  decided: Set<string>;
  messages: ChatMessageWire[] | null;
  conversations: Array<{ id: string; title: string | null; updatedAt: string }> | null;
  removedInboxes: Set<string>;
  removedCalendars: Set<string>;
  removedDrive: Set<string>;
  uploaded: Array<(typeof MOCK_DRIVE_FILES)[number]>;
  notifications: typeof MOCK_NOTIFICATION_SETTINGS;
  pushTokens: Set<string>;
  deleted: boolean;
}

function freshState(): HubState {
  return {
    created: [],
    decided: new Set(),
    messages: null,
    conversations: null,
    removedInboxes: new Set(),
    removedCalendars: new Set(),
    removedDrive: new Set(),
    uploaded: [],
    notifications: { ...MOCK_NOTIFICATION_SETTINGS },
    pushTokens: new Set(),
    deleted: false,
  };
}

const state = freshState();

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NOT_FOUND = () =>
  json(404, { message: "Route not found", error: "Not Found", statusCode: 404 });

function pendingActions(now: number, empty: boolean): PendingActionWire[] {
  return mockPendingActions(now, empty).filter((a) => !state.decided.has(a.id));
}

function readBody<T>(body: unknown): T {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as T;
    } catch {
      return {} as T;
    }
  }
  return (body ?? {}) as T;
}

/** A canned reply for a new chat turn, in the spirit of the real assistant. */
function cannedReply(
  text: string,
  now: number,
): { reply: string; eventDraft: EventDraftWire | null } {
  if (/회의|미팅|일정|meeting|schedule/i.test(text) && /잡|만들|schedule|set up|book/i.test(text)) {
    const start = new Date(now + 26 * 60 * 60_000);
    start.setUTCMinutes(0, 0, 0);
    return {
      reply:
        "세 캘린더 모두 비어 있는 내일 오후 시간으로 초안을 만들었어요. 카드에서 확인하고 저장해 주세요.",
      eventDraft: {
        title: "회의",
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 60 * 60_000).toISOString(),
      },
    };
  }
  return {
    reply:
      "확인했어요. 답장이 필요한 급한 메일은 박서연 님의 계약서 회신 한 통이에요. 오늘 18시가 마감이에요.",
    eventDraft: null,
  };
}

export function handleHub(req: HubRequest): Response | null {
  const { pathname, searchParams, method, scenario, now } = req;
  const off = scenario === "featuresOff";
  const empty = scenario === "empty" || scenario === "noAccounts";

  // ── Calendar ──────────────────────────────────────────────────────────
  if (pathname === "/api/calendar" && method === "GET") {
    const all = empty ? [] : [...mockWeekEvents(now), ...state.created];
    return json(200, {
      events: eventsInRange(all, searchParams.get("start"), searchParams.get("end")),
    });
  }
  if (pathname === "/api/calendar" && method === "POST") {
    const draft = readBody<EventDraftWire>(req.body);
    if (!draft.title?.trim() || !draft.startTime || !draft.endTime) {
      return json(400, { error: "title is required" });
    }
    const event: CalendarEventWire = {
      id: `evt-new-${state.created.length + 1}`,
      title: draft.title.trim(),
      startTime: draft.startTime,
      endTime: draft.endTime,
      location: draft.location ?? null,
      description: draft.description ?? null,
      allDay: draft.allDay === true,
      provider: "GOOGLE",
      sourceAccountId: null,
    };
    state.created.push(event);
    return json(200, event);
  }
  if (pathname === "/api/calendar/parse-event" && method === "POST") {
    const { text } = readBody<{ text?: string }>(req.body);
    const start = new Date(now + 24 * 60 * 60_000);
    start.setUTCMinutes(0, 0, 0);
    return json(200, {
      event: {
        title: (text ?? "").replace(/(내일|오늘|오후|오전|\d+시)/g, "").trim() || "새 일정",
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 60 * 60_000).toISOString(),
      },
    });
  }
  const eventId = pathname.match(/^\/api\/calendar\/([^/]+)$/)?.[1];
  if (eventId && method === "GET" && eventId !== "parse-event") {
    const found = [...mockWeekEvents(now), ...state.created].find(
      (e) => e.id === decodeURIComponent(eventId),
    );
    return found ? json(200, found) : json(404, { error: "Event not found" });
  }

  // ── Teams ─────────────────────────────────────────────────────────────
  if (pathname.startsWith("/api/teams")) {
    if (off) return json(403, { error: "Team mode is not enabled.", code: "TEAM_REQUIRED" });
    if (pathname === "/api/teams") return json(200, { teams: empty ? [] : MOCK_TEAMS });
    if (/^\/api\/teams\/[^/]+\/availability$/.test(pathname))
      return json(200, mockTeamAvailability(now));
    return NOT_FOUND();
  }

  // ── Assistant ─────────────────────────────────────────────────────────
  if (pathname === "/api/chat/pending-actions" && method === "GET") {
    return json(200, { actions: pendingActions(now, empty) });
  }
  const decision = pathname.match(
    /^\/api\/chat\/pending-actions\/([^/]+)\/(approve|reject|snooze)$/,
  );
  if (decision?.[1] && method === "POST") {
    const id = decodeURIComponent(decision[1]);
    if (state.decided.has(id)) return json(400, { error: "Action already executed" });
    state.decided.add(id);
    if (decision[2] === "approve") return json(200, { success: true, result: "ok" });
    if (decision[2] === "snooze")
      return json(200, { success: true, snoozedUntil: new Date(now + 3_600_000).toISOString() });
    return json(200, { success: true, neverSuggested: false });
  }
  if (pathname === "/api/chat/conversations" && method === "GET") {
    state.conversations ??= empty ? [] : [MOCK_CONVERSATION];
    return json(200, { conversations: state.conversations });
  }
  if (pathname === "/api/chat/conversations" && method === "POST") {
    const conversation = {
      id: `conv-${Date.now().toString(36)}`,
      title: null,
      updatedAt: new Date(now).toISOString(),
    };
    state.conversations = [conversation, ...(state.conversations ?? [])];
    state.messages = [];
    return json(200, conversation);
  }
  const thread = pathname.match(/^\/api\/chat\/conversations\/([^/]+)\/messages$/);
  if (thread?.[1]) {
    state.messages ??= empty ? [] : mockChatMessages(now);
    if (method === "GET") return json(200, { messages: state.messages });
    const { text } = readBody<{ text?: string }>(req.body);
    if (!text?.trim()) return json(400, { error: "text is required" });
    const turn = cannedReply(text, now);
    const at = new Date(now).toISOString();
    state.messages = [
      ...state.messages,
      {
        id: `m-${state.messages.length + 1}`,
        role: "USER",
        content: text.trim(),
        metadata: { source: "chat" },
        createdAt: at,
      },
      {
        id: `m-${state.messages.length + 2}`,
        role: "ASSISTANT",
        content: turn.reply,
        metadata: { source: "chat", ...(turn.eventDraft ? { eventDraft: turn.eventDraft } : {}) },
        createdAt: at,
      },
    ];
    return json(200, turn);
  }
  if (pathname === "/api/inbox/receipt/today") return json(200, mockReceipt(now, empty));

  // ── Files ─────────────────────────────────────────────────────────────
  if (pathname.startsWith("/api/drive")) {
    if (off) return NOT_FOUND();
    if (pathname === "/api/drive/files" && method === "GET") {
      const q = (searchParams.get("q") ?? "").trim().toLowerCase();
      const provider = searchParams.get("provider");
      const files = empty
        ? []
        : [...state.uploaded, ...MOCK_DRIVE_FILES].filter(
            (f) =>
              (!provider || f.provider === provider) &&
              (!q ||
                f.name.toLowerCase().includes(q) ||
                (MOCK_DRIVE_SUMMARIES[f.id] ?? "").toLowerCase().includes(q)),
          );
      return json(200, { files, nextCursor: null });
    }
    if (pathname === "/api/drive/files" && method === "POST") {
      const form = req.body as FormData | null;
      const file = form instanceof FormData ? (form.get("file") as File | null) : null;
      if (!file)
        return json(400, { error: "invalid upload", code: "invalid-upload", retryable: false });
      const row = {
        id: `drv-up-${state.uploaded.length + 1}`,
        provider: "KLORN" as const,
        sourceKey: "klorn",
        externalId: `k-up-${state.uploaded.length + 1}`,
        name: file.name || "upload",
        mimeType: file.type || null,
        isFolder: false,
        sizeBytes: file.size,
        parentExternalId: null,
        modifiedAt: new Date(now).toISOString(),
        webUrl: null,
        readOnly: false,
      };
      state.uploaded.unshift(row);
      return json(201, { file: row });
    }
    if (pathname === "/api/drive/limits") return json(200, MOCK_DRIVE_LIMITS);
    const fileMatch = pathname.match(/^\/api\/drive\/files\/([^/]+)(\/download|\/summarize)?$/);
    if (fileMatch?.[1]) {
      const id = decodeURIComponent(fileMatch[1]);
      const file = [...state.uploaded, ...MOCK_DRIVE_FILES].find((f) => f.id === id);
      if (!file) return json(404, { error: "File not found" });
      const text = MOCK_DRIVE_SUMMARIES[id] ?? null;
      const summary = text
        ? { status: "DONE", text, error: null, summarizedAt: new Date(now).toISOString() }
        : { status: "PENDING", text: null, error: null, summarizedAt: null };
      if (fileMatch[2] === "/download") {
        return json(200, {
          url: `https://storage.mock.klorn.invalid/${file.externalId}?sig=mock`,
          expiresInSeconds: 300,
        });
      }
      if (fileMatch[2] === "/summarize") return json(200, { summary });
      return json(200, { file, summary });
    }
    if (pathname === "/api/drive/google/accounts" && method === "GET") {
      return json(200, {
        accounts: MOCK_GOOGLE_DRIVE_ACCOUNTS.filter((a) => !state.removedDrive.has(a.id)),
      });
    }
    if (pathname === "/api/drive/google/link" && method === "POST") {
      return json(200, { url: "https://accounts.google.com/o/oauth2/v2/auth?mock=drive" });
    }
    const unlink = pathname.match(/^\/api\/drive\/google\/accounts\/([^/]+)$/);
    if (unlink?.[1] && method === "DELETE") {
      state.removedDrive.add(decodeURIComponent(unlink[1]));
      return json(200, { success: true });
    }
    return NOT_FOUND();
  }
  if (pathname === "/api/email" && searchParams.get("filter") === "attachments") {
    const emails = empty ? [] : mockAttachmentList(now);
    return json(200, { emails, source: "gmail", total: emails.length, unread: 0, page: 1 });
  }
  const mailId = pathname.match(/^\/api\/email\/([^/]+)$/)?.[1];
  if (mailId && method === "GET") {
    const detail = mockAttachmentDetail(now, decodeURIComponent(mailId));
    if (detail) return json(200, detail);
  }

  // ── Accounts ──────────────────────────────────────────────────────────
  if (
    /^\/api\/auth\/(google\/(start|link-inbox|link-calendar)|outlook\/link-inbox)$/.test(pathname)
  ) {
    if (off && pathname.includes("outlook")) return NOT_FOUND();
    return json(200, {
      url: `https://accounts.example/oauth?mock=${encodeURIComponent(pathname)}`,
    });
  }
  if (pathname === "/api/auth/link/complete" && method === "POST") {
    return json(200, { next: "/settings?inbox=success" });
  }
  if (pathname === "/api/auth/outlook/linked-inboxes") {
    if (off) return NOT_FOUND();
    return json(200, { accounts: [] });
  }
  const imap = pathname.match(/^\/api\/(naver|icloud|generic)-imap\/(status|connect|disconnect)$/);
  if (imap?.[1]) {
    const kind = imap[1] as "naver" | "icloud" | "generic";
    if (off && kind !== "naver") return NOT_FOUND();
    if (imap[2] === "status") return json(200, mockImapStatus(kind));
    if (imap[2] === "disconnect") {
      const { email } = readBody<{ email?: string }>(req.body);
      state.removedInboxes.add(`${kind}:${email ?? ""}`);
      return json(200, { ok: true });
    }
    const body = readBody<{ email?: string; password?: string }>(req.body);
    if (!body.password || body.password.length < 6) {
      return json(400, {
        ok: false,
        message: "로그인하지 못했어요. 앱 전용 비밀번호를 확인해 주세요.",
      });
    }
    return json(200, { ok: true, email: body.email, firstSync: true });
  }
  const linkedInbox = pathname.match(/^\/api\/auth\/(google|outlook)\/linked-inboxes\/([^/]+)$/);
  if (linkedInbox?.[2] && method === "DELETE") {
    state.removedInboxes.add(decodeURIComponent(linkedInbox[2]));
    return json(200, { success: true });
  }
  if (pathname === "/api/auth/google" && method === "DELETE") {
    state.removedInboxes.add("primary");
    return json(204, null);
  }
  const calendars = pathname.match(
    /^\/api\/(?:auth\/(google|outlook)|(caldav)-calendar)\/linked-calendars(?:\/([^/]+))?$/,
  );
  if (calendars) {
    const source = (calendars[1] ?? calendars[2]) as "google" | "outlook" | "caldav";
    if (off && source !== "google") return NOT_FOUND();
    if (calendars[3] && method === "DELETE") {
      state.removedCalendars.add(decodeURIComponent(calendars[3]));
      return json(200, { success: true });
    }
    const list = MOCK_LINKED_CALENDARS[source];
    return json(200, { accounts: list.accounts.filter((a) => !state.removedCalendars.has(a.id)) });
  }
  if (pathname === "/api/device-calendar/sources") return NOT_FOUND();
  if (pathname === "/api/providers/available") return NOT_FOUND();

  // ── Settings · Push · Plans ───────────────────────────────────────────
  if (pathname === "/api/automations" && method === "GET") return json(200, state.notifications);
  if (pathname === "/api/automations" && method === "PATCH") {
    state.notifications = {
      ...state.notifications,
      ...readBody<Partial<typeof state.notifications>>(req.body),
    };
    return json(200, state.notifications);
  }
  if (pathname === "/api/auth/account" && method === "DELETE") {
    state.deleted = true;
    return json(204, null);
  }
  if (pathname === "/api/notifications/push/device-token/register" && method === "POST") {
    const { token } = readBody<{ token?: string }>(req.body);
    if (token) state.pushTokens.add(token);
    return json(201, { success: true });
  }
  if (pathname === "/api/notifications/push/device-token" && method === "DELETE")
    return json(204, null);
  if (pathname === "/api/billing/status") return json(200, MOCK_BILLING);

  return null;
}
