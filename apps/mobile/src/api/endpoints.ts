/**
 * Typed endpoints — every route the mobile app calls, in one place, with the
 * server file that answers it. Shapes come from @klorn/contract where the
 * contract has them, else from ./wire.ts.
 */
import type {
  AttentionByEmailDismissResponse,
  AttentionByEmailSnoozeResponse,
  AuthProvidersResponse,
  BriefingStatus,
  DailyReceipt,
  DriveDownloadResponse,
  DriveFileResponse,
  DriveFilesListResponse,
  DriveLimitsResponse,
  DriveProviderWire,
  DriveSummarizeResponse,
  DriveUploadResponse,
  EmailLaneCountsResponse,
  EmailListResponse,
  EmailReaderContextResponse,
  FirewallResponse,
  GoogleDriveAccountsResponse,
  InboxesResponse,
  LaneOverrideByEmailResponse,
  LaneOverrideUndoResponse,
  LiveTier,
  SendEmailRequest,
  TeamAvailabilityResponse,
  TeamsListResponse,
} from "@klorn/contract";
import { NATIVE_OAUTH_SCHEME } from "../config";
import type { ApiClient, RequestOptions } from "./client";
import type {
  ApproveActionResponse,
  AttachmentMailWire,
  BillingStatusWire,
  CalendarEventsResponse,
  CalendarEventWire,
  ChatMessagesResponse,
  ChatTurnResponse,
  ConversationsResponse,
  ConversationWire,
  DesktopNonceResponse,
  DesktopTokenResponse,
  EmailDetailWire,
  EmailSubscriptionsResponse,
  EmailSubscriptionUnsubscribeResponse,
  EventDraftWire,
  ExchangeCodeResponse,
  ImapConnectResponse,
  ImapStatusWire,
  LinkCompleteResponse,
  LinkedCalendarsResponse,
  LinkStartResponse,
  LoginResponse,
  MeResponse,
  NotificationSettingsWire,
  PendingActionsResponse,
  ReplyDraftResponse,
  SavedDraftResponse,
  SenderDossierWire,
  SendMailResponse,
  ThreadBriefResponse,
} from "./wire";

/** The IMAP-connected providers and their route prefixes (routes/imap-connect.ts). */
export type ImapKind = "naver" | "icloud" | "generic";

/** Every account-link start asks the callback to relay to the app (routes/link-handoff.ts). */
const LINK_RELAY = `?appScheme=${encodeURIComponent(NATIVE_OAUTH_SCHEME)}`;

/** A lane filter as Mail's list takes it (`tier=`): a live lane or ALL. */
export type LaneFilter = LiveTier | "ALL";

/** `inbox=` scope: every account, the primary one, or a linked inbox id. */
export type InboxScope = "all" | "primary" | (string & {});

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export function endpoints(api: ApiClient) {
  return {
    auth: {
      /** routes/auth.ts GET /providers — which sign-in buttons this deployment has. */
      providers: (o?: RequestOptions) =>
        api.get<AuthProvidersResponse>("/api/auth/providers", { anonymous: true, ...o }),
      /** routes/auth.ts POST /login */
      login: (email: string, password: string) =>
        api.post<LoginResponse>("/api/auth/login", { email, password }, { anonymous: true }),
      /**
       * routes/auth.ts POST /register — email sign-up (201 { token, user }).
       * 403 while BETA_GATE_ENABLED keeps sign-up to approved waitlist
       * addresses, 409 for a registered address, 400 for a short password,
       * 429 after 5 tries in 15 minutes.
       */
      register: (email: string, password: string, name?: string) =>
        api.post<LoginResponse>(
          "/api/auth/register",
          { email, password, ...(name ? { name } : {}) },
          { anonymous: true },
        ),
      /** routes/auth.ts GET /signup-status — false while sign-up is invite-only (BETA_GATE). */
      signupStatus: (o?: RequestOptions) =>
        api.get<{ open: boolean }>("/api/auth/signup-status", { anonymous: true, ...o }),
      /** routes/auth.ts GET /me */
      me: (o?: RequestOptions) => api.get<MeResponse>("/api/auth/me", o),
      /** routes/auth.ts POST /logout — drops this device's session row. */
      logout: () => api.post<{ success: boolean }>("/api/auth/logout"),
      /** routes/auth.ts GET /desktop-nonce — PKCE challenge required. */
      desktopNonce: (challenge: string) =>
        api.get<DesktopNonceResponse>(`/api/auth/desktop-nonce${query({ challenge })}`, {
          anonymous: true,
        }),
      /** routes/auth.ts GET /desktop-token/:nonce — the PKCE-bound poll (browser fallback). */
      desktopToken: async (nonce: string, verifier: string) => {
        const { data } = await api.request<DesktopTokenResponse>(
          "GET",
          `/api/auth/desktop-token/${encodeURIComponent(nonce)}`,
          undefined,
          { anonymous: true, headers: { "x-desktop-verifier": verifier } },
        );
        return data;
      },
      /** routes/auth.ts POST /exchange-code — the relay's one-time code → JWT. */
      exchangeCode: (code: string) =>
        api.post<ExchangeCodeResponse>("/api/auth/exchange-code", { code }, { anonymous: true }),
      /**
       * The URL the system browser opens for a social login (routes/auth.ts
       * GET /google/login, routes/social-auth.ts GET /apple/login). The
       * `appScheme` asks the callback to relay to the app's custom scheme.
       */
      socialLoginUrl: (provider: "google" | "apple", nonce: string, appScheme?: string) =>
        `${api.baseUrl}/api/auth/${provider}/login${query({ source: "desktop", nonce, appScheme })}`,
    },
    mail: {
      /** routes/inbox/firewall GET / — open attention items by lane, with reasons. */
      firewall: (inbox?: InboxScope, o?: RequestOptions) =>
        api.get<FirewallResponse>(`/api/inbox/firewall${query({ inbox })}`, o),
      /** routes/email-lanes.ts GET /lane-counts (dark unless MAIL_V2 or UNIFIED_HOME). */
      laneCounts: (inbox?: InboxScope, o?: RequestOptions) =>
        api.get<EmailLaneCountsResponse>(`/api/email/lane-counts${query({ inbox })}`, o),
      /**
       * routes/email.ts GET / — the paged list; `tier` honoured while a lane
       * reader is on. Always `hideHandled=1`: mail whose attention item is Done
       * (DISMISSED) or still under a Later (SNOOZED) is left out by the server,
       * so a Done on one device is gone on the others too.
       */
      list: (
        params: { tier?: LaneFilter; page?: number; inbox?: InboxScope; search?: string },
        o?: RequestOptions,
      ) =>
        api.get<EmailListResponse>(
          `/api/email${query({
            search: params.search?.trim(),
            page: params.page ?? 1,
            inbox: params.inbox === "all" ? undefined : params.inbox,
            tier: params.tier,
            hideHandled: 1,
          })}`,
          o,
        ),
      /** routes/email.ts GET /:id */
      detail: (id: string, o?: RequestOptions) =>
        api.get<EmailDetailWire>(`/api/email/${encodeURIComponent(id)}`, o),
      /** routes/email.ts GET /inboxes — the connected accounts ("inboxes"). */
      inboxes: (o?: RequestOptions) => api.get<InboxesResponse>("/api/email/inboxes", o),
      /**
       * routes/email-lanes.ts GET /:id/reader-context — lane + tierReason + the
       * mail's neighbours in the list view (dark 404 unless MAIL_V2; the reader
       * then falls back to the firewall item and the cached list).
       */
      readerContext: (
        id: string,
        view: { tier: LaneFilter; inbox: InboxScope; search?: string },
        o?: RequestOptions,
      ) =>
        api.get<EmailReaderContextResponse>(
          `/api/email/${encodeURIComponent(id)}/reader-context${query({
            tier: view.tier,
            inbox: view.inbox === "all" ? undefined : view.inbox,
            search: view.search?.trim(),
          })}`,
          o,
        ),
      /**
       * routes/email.ts POST /sync — pull-to-refresh: new mail from the primary
       * account and every linked inbox. Answers 200 with `{ error }` on a dead
       * token, so the caller treats `error` as a failure.
       */
      sync: () =>
        api.post<{ newCount?: number; synced?: number; error?: string }>("/api/email/sync"),
      /**
       * routes/email-mutations.ts PATCH /:id/read — reading is a GET and side-effect
       * free; marking read is this explicit write (synced to the mail's own account).
       */
      markRead: (id: string, isRead = true) =>
        api.request<{ success?: boolean }>("PATCH", `/api/email/${encodeURIComponent(id)}/read`, {
          isRead,
        }),
      /** routes/email.ts GET /:id/thread-brief — "why did they write now" ({brief:null} for IMAP). */
      threadBrief: (id: string, lang: "ko" | "en", o?: RequestOptions) =>
        api.get<ThreadBriefResponse>(
          `/api/email/${encodeURIComponent(id)}/thread-brief${query({ lang })}`,
          o,
        ),
      /** routes/email.ts GET /:id/sender-dossier — relationship context (503 without an AI key). */
      senderDossier: (id: string, lang: "ko" | "en", o?: RequestOptions) =>
        api.get<SenderDossierWire>(
          `/api/email/${encodeURIComponent(id)}/sender-dossier${query({ lang })}`,
          o,
        ),
      /**
       * routes/email-attachments.ts GET /:id/attachments/:attachmentId/download —
       * bytes from the mail's OWN account (linked inbox included). Authenticated,
       * so the reader fetches it and hands the blob to the OS.
       */
      attachmentPath: (id: string, attachmentId: string) =>
        `/api/email/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/download`,
    },
    /**
     * Replies and new mail. Sending is one of the three real-world actions
     * (deterministic floor): it only ever happens from the confirm sheet, on
     * an explicit tap, with exactly the bytes shown there.
     */
    compose: {
      /** routes/email-replies.ts POST /:id/reply-draft — `intent` steers a regeneration. */
      replyDraft: (id: string, intent?: string) =>
        api.post<ReplyDraftResponse>(
          `/api/email/${encodeURIComponent(id)}/reply-draft`,
          intent ? { intent } : {},
        ),
      /**
       * routes/email-replies.ts POST /:id/reply — sends from the mail's own
       * account (the server reads linkedInboxAccountId from the row), threaded.
       */
      sendReply: (id: string, body: string) =>
        api.post<SendMailResponse>(`/api/email/${encodeURIComponent(id)}/reply`, { body }),
      /** routes/email-replies.ts POST /:id/gmail-draft — keep it as a draft in the account. */
      saveReplyDraft: (id: string, draft: { to: string; subject: string; body: string }) =>
        api.post<SavedDraftResponse>(`/api/email/${encodeURIComponent(id)}/gmail-draft`, draft),
      /**
       * routes/email-mutations.ts POST /send — a new mail, from the account the
       * user picked: `linkedInboxAccountId` null = the primary inbox, else one of
       * the caller's linked inboxes (404 if it is not theirs, never a silent
       * primary send; 501 when that provider cannot send from Klorn).
       */
      send: (mail: SendEmailRequest) => api.post<SendMailResponse>("/api/email/send", mail),
    },
    /**
     * routes/email-subscriptions.ts — dark (404) unless BULK_UNSUBSCRIBE_ENABLED;
     * Mail hides its entry point on 404.
     */
    subscriptions: {
      list: (o?: RequestOptions) =>
        api.get<EmailSubscriptionsResponse>("/api/email/subscriptions", o),
      /** `archive` clears that sender's recent mail from the lists too; nothing is deleted. */
      unsubscribe: (sub: {
        sender: string;
        linkedInboxAccountId: string | null;
        archive: boolean;
      }) =>
        api.post<EmailSubscriptionUnsubscribeResponse>("/api/email/subscriptions/unsubscribe", sub),
    },
    /**
     * Row triage (founder decision 2026-10-16: there is no archive gesture).
     * None of these touch the mailbox itself; a lane is a classification,
     * never an action.
     */
    triage: {
      /**
       * Swipe right, "Done": routes/firewall.ts POST /email/:emailId/dismiss —
       * keyed by the EmailMessage id, so it works for any mail in any account,
       * not only the firewall's newest-200 window. The mail's attention item
       * becomes DISMISSED; the source email is untouched. `alreadyClear` = nothing
       * changed (already done, resolved, or not classified yet — `itemId: null`).
       * The server has no un-dismiss, so the 5 s undo is client-side: hide
       * optimistically, send this only once the window ends.
       */
      doneByEmail: (emailId: string) =>
        api.post<AttentionByEmailDismissResponse>(
          `/api/inbox/firewall/email/${encodeURIComponent(emailId)}/dismiss`,
        ),
      /** "Later" by email id: POST /email/:emailId/snooze — back in the lists at `until`. */
      snoozeByEmail: (emailId: string, until: Date) =>
        api.post<AttentionByEmailSnoozeResponse>(
          `/api/inbox/firewall/email/${encodeURIComponent(emailId)}/snooze`,
          { snoozeUntil: until.toISOString() },
        ),
      /**
       * Done by attention item id (routes/firewall.ts POST /:id/dismiss): the
       * Flip cover (it holds firewall items) and a notification that carries
       * only an `attentionItemId`.
       */
      done: (attentionItemId: string) =>
        api.post<{ ok: true }>(
          `/api/inbox/firewall/${encodeURIComponent(attentionItemId)}/dismiss`,
        ),
      /** "Later" by attention item id: routes/firewall.ts POST /:id/snooze — back to OPEN at `until`. */
      snooze: (attentionItemId: string, until: Date) =>
        api.post<{ ok: true; snoozedUntil: string }>(
          `/api/inbox/firewall/${encodeURIComponent(attentionItemId)}/snooze`,
          { snoozeUntil: until.toISOString() },
        ),
      /**
       * Swipe left → lane sheet → "Move to <LANE>": routes/firewall.ts
       * POST /email/:emailId. Reversible: the answer carries `itemId` +
       * `undoToken` (+ `undoExpiresAt`) for `undoMove`. The server learns from
       * the correction (two identical moves auto-pin the sender,
       * learning/sender-policy.ts).
       */
      moveLane: (emailId: string, tier: LiveTier) =>
        api.post<LaneOverrideByEmailResponse>(
          `/api/inbox/firewall/email/${encodeURIComponent(emailId)}`,
          { tier },
        ),
      /**
       * routes/firewall.ts POST /:id — the older, irreversible override by
       * attention item id. Only used while KEYBOARD_TRIAGE keeps the by-email
       * route dark (Fastify's bare 404).
       */
      moveLaneByItem: (attentionItemId: string, tier: LiveTier) =>
        api.post<{ ok: true; tier: LiveTier }>(
          `/api/inbox/firewall/${encodeURIComponent(attentionItemId)}`,
          { tier },
        ),
      /** routes/firewall.ts POST /:id/undo — 409 undo_expired / undo_conflict change nothing. */
      undoMove: (attentionItemId: string, undoToken: string) =>
        api.post<LaneOverrideUndoResponse>(
          `/api/inbox/firewall/${encodeURIComponent(attentionItemId)}/undo`,
          { undoToken },
        ),
      /** "Keep this sender here": routes/email.ts POST /:id/pin-tier (sender scope). */
      pinSender: (emailId: string, tier: LiveTier) =>
        api.post<{ pinned: true; sender: string; tier: LiveTier }>(
          `/api/email/${encodeURIComponent(emailId)}/pin-tier`,
          { tier, scope: "sender" },
        ),
      /** routes/email.ts DELETE /:id/pin-tier */
      unpinSender: (emailId: string) =>
        api.del<{ pinned: false; sender: string }>(
          `/api/email/${encodeURIComponent(emailId)}/pin-tier`,
        ),
    },
    calendar: {
      /** routes/calendar.ts GET /?start=&end= — every connected calendar, merged. */
      events: (start: Date, end: Date, o?: RequestOptions) =>
        api.get<CalendarEventsResponse>(
          `/api/calendar${query({ start: start.toISOString(), end: end.toISOString() })}`,
          o,
        ),
      /** routes/calendar.ts GET /:id — one event (404 for a hidden or foreign row). */
      event: (id: string, o?: RequestOptions) =>
        api.get<CalendarEventWire>(`/api/calendar/${encodeURIComponent(id)}`, o),
      /**
       * routes/calendar.ts POST / — the ONLY calendar write the app makes, sent
       * after the user confirms the draft card (Pro-gated: 402/403 → Plans).
       */
      create: (draft: EventDraftWire) => api.post<CalendarEventWire>("/api/calendar", draft),
      /** routes/calendar.ts POST /parse-event — free text → a draft; writes nothing. */
      parseEvent: (text: string) =>
        api.post<{ event: Partial<EventDraftWire> | null }>("/api/calendar/parse-event", { text }),
    },
    assistant: {
      /** routes/chat-pending-actions.ts GET /pending-actions — Approvals. */
      pendingActions: (o?: RequestOptions) =>
        api.get<PendingActionsResponse>("/api/chat/pending-actions", o),
      /** routes/briefing GET /status — the stored briefing; reading it runs no model. */
      briefingStatus: (o?: RequestOptions) => api.get<BriefingStatus>("/api/briefing/status", o),
      /** routes/chat-pending-actions.ts POST /:id/approve — runs the action (a send mints a receipt). */
      approve: (id: string) =>
        api.post<ApproveActionResponse>(
          `/api/chat/pending-actions/${encodeURIComponent(id)}/approve`,
        ),
      /** routes/chat-pending-actions.ts POST /:id/reject — nothing runs; the reason teaches. */
      reject: (id: string, reason?: string) =>
        api.post<{ success: boolean }>(
          `/api/chat/pending-actions/${encodeURIComponent(id)}/reject`,
          reason?.trim() ? { reason: reason.trim() } : {},
        ),
      /** routes/chat-pending-actions.ts POST /:id/snooze */
      snooze: (id: string, until: Date) =>
        api.post<{ success: boolean; snoozedUntil: string }>(
          `/api/chat/pending-actions/${encodeURIComponent(id)}/snooze`,
          { snoozeUntil: until.toISOString() },
        ),
      /** routes/chat-conversations.ts GET /conversations — newest first. */
      conversations: (o?: RequestOptions) =>
        api.get<ConversationsResponse>("/api/chat/conversations", o),
      /** routes/chat-conversations.ts POST /conversations */
      createConversation: () => api.post<ConversationWire>("/api/chat/conversations"),
      /** routes/chat-conversations.ts GET /conversations/:id/messages */
      messages: (id: string, o?: RequestOptions) =>
        api.get<ChatMessagesResponse>(
          `/api/chat/conversations/${encodeURIComponent(id)}/messages`,
          o,
        ),
      /**
       * routes/chat-conversations.ts POST /conversations/:id/messages — one
       * turn. `emailId` names the mail on screen so "this email" resolves.
       * Chat only ever drafts: an event is written by calendar.create alone.
       */
      send: (id: string, text: string, emailId?: string | null) =>
        api.post<ChatTurnResponse>(`/api/chat/conversations/${encodeURIComponent(id)}/messages`, {
          text,
          ...(emailId ? { context: { emailId } } : {}),
        }),
      /** routes/receipt.ts GET /today — Activity (what Klorn did and decided today). */
      receipt: (o?: RequestOptions) => api.get<DailyReceipt>("/api/inbox/receipt/today", o),
    },
    teams: {
      /** routes/teams.ts GET / — 403 TEAM_REQUIRED while team mode is off. */
      list: (o?: RequestOptions) => api.get<TeamsListResponse>("/api/teams", o),
      /** routes/teams.ts GET /:id/availability — read-only common free slots. */
      availability: (id: string, start: Date, end: Date, minutes: number, o?: RequestOptions) =>
        api.get<TeamAvailabilityResponse>(
          `/api/teams/${encodeURIComponent(id)}/availability${query({
            window_start: start.toISOString(),
            window_end: end.toISOString(),
            duration_minutes: minutes,
          })}`,
          o,
        ),
    },
    /** routes/drive.ts, klorn-drive.ts, google-drive-link.ts — all 404 while their flags are off. */
    files: {
      list: (
        params: {
          q?: string;
          provider?: DriveProviderWire;
          cursor?: string | null;
          limit?: number;
        },
        o?: RequestOptions,
      ) =>
        api.get<DriveFilesListResponse>(
          `/api/drive/files${query({
            q: params.q?.trim().slice(0, 100),
            provider: params.provider,
            cursor: params.cursor ?? undefined,
            limit: params.limit ?? 50,
          })}`,
          o,
        ),
      file: (id: string, o?: RequestOptions) =>
        api.get<DriveFileResponse>(`/api/drive/files/${encodeURIComponent(id)}`, o),
      summarize: (id: string) =>
        api.post<DriveSummarizeResponse>(`/api/drive/files/${encodeURIComponent(id)}/summarize`),
      /** A signed storage link (≤ 300 s), opened WITHOUT the Bearer header. */
      download: (id: string) =>
        api.get<DriveDownloadResponse>(`/api/drive/files/${encodeURIComponent(id)}/download`),
      limits: (o?: RequestOptions) => api.get<DriveLimitsResponse>("/api/drive/limits", o),
      /** klorn-drive.ts POST /files — multipart, `size` before `file` (the server reads in order). */
      upload: (file: Blob, name: string) => {
        const form = new FormData();
        form.append("size", String(file.size));
        form.append("file", file, name);
        return api.post<DriveUploadResponse>("/api/drive/files", form);
      },
      /** routes/email.ts GET /:id — the attachments of one mail (Files' mail source). */
      attachmentsOf: (emailId: string, o?: RequestOptions) =>
        api.get<AttachmentMailWire>(`/api/email/${encodeURIComponent(emailId)}`, o),
      /** routes/email.ts GET /?filter=attachments — mail that carries attachments. */
      attachmentMail: (page = 1, o?: RequestOptions) =>
        api.get<EmailListResponse>(`/api/email${query({ filter: "attachments", page })}`, o),
      googleAccounts: (o?: RequestOptions) =>
        api.get<GoogleDriveAccountsResponse>("/api/drive/google/accounts", o),
      linkGoogle: () => api.post<LinkStartResponse>(`/api/drive/google/link${LINK_RELAY}`),
      unlinkGoogle: (id: string) =>
        api.del<{ success: true }>(`/api/drive/google/accounts/${encodeURIComponent(id)}`),
    },
    /**
     * Account links. Each OAuth start returns a consent URL for the SYSTEM
     * browser; the callback deep-links ai.klorn.app://link-complete?h=… and the
     * app finishes it with its own session (linkComplete).
     */
    accounts: {
      /** routes/auth.ts POST /google/start (the primary Gmail) or /google/link-inbox (another). */
      startGoogle: (primary: boolean) =>
        api.post<LinkStartResponse>(
          `/api/auth/google/${primary ? "start" : "link-inbox"}${LINK_RELAY}`,
        ),
      /** routes/outlook-auth.ts POST /link-inbox (404 while OUTLOOK_INBOX_ENABLED is off). */
      startOutlook: () => api.post<LinkStartResponse>(`/api/auth/outlook/link-inbox${LINK_RELAY}`),
      /** routes/auth.ts POST /google/link-calendar — another Google calendar (Pro). */
      startGoogleCalendar: () =>
        api.post<LinkStartResponse>(`/api/auth/google/link-calendar${LINK_RELAY}`),
      /** routes/link-complete.ts POST /link/complete — 404 LINK_EXPIRED, 409 other session. */
      linkComplete: (handle: string) =>
        api.post<LinkCompleteResponse>("/api/auth/link/complete", { handle }),
      outlookInboxes: (o?: RequestOptions) =>
        api.get<{ accounts: Array<{ id: string; email: string }> }>(
          "/api/auth/outlook/linked-inboxes",
          o,
        ),
      imapStatus: (kind: ImapKind, o?: RequestOptions) =>
        api.get<ImapStatusWire>(`/api/${kind}-imap/status`, o),
      imapConnect: (kind: ImapKind, body: { email: string; password: string; host?: string }) =>
        api.post<ImapConnectResponse>(`/api/${kind}-imap/connect`, body),
      imapDisconnect: (kind: ImapKind, email: string) =>
        api.post<{ ok: boolean }>(`/api/${kind}-imap/disconnect`, { email }),
      unlinkGoogleInbox: (id: string) =>
        api.del<{ success: true }>(`/api/auth/google/linked-inboxes/${encodeURIComponent(id)}`),
      unlinkOutlookInbox: (id: string) =>
        api.del<{ success: true }>(`/api/auth/outlook/linked-inboxes/${encodeURIComponent(id)}`),
      /** routes/auth.ts DELETE /google — drops the primary Gmail grant (not the Klorn account). */
      disconnectPrimaryGoogle: () => api.del<null>("/api/auth/google"),
      /** Google (Pro-gated: 403), Outlook and CalDAV (404 while off) linked calendars. */
      linkedCalendars: (source: "google" | "outlook" | "caldav", o?: RequestOptions) =>
        api.get<LinkedCalendarsResponse>(
          source === "caldav"
            ? "/api/caldav-calendar/linked-calendars"
            : `/api/auth/${source}/linked-calendars`,
          o,
        ),
      unlinkCalendar: (source: "google" | "outlook" | "caldav", id: string) =>
        api.del<{ success: true }>(
          `${
            source === "caldav" ? "/api/caldav-calendar" : `/api/auth/${source}`
          }/linked-calendars/${encodeURIComponent(id)}`,
        ),
    },
    settings: {
      /** routes/automations.ts GET / — the notification fields are read from it. */
      notifications: (o?: RequestOptions) =>
        api.get<NotificationSettingsWire>("/api/automations", o),
      /** routes/automations.ts PATCH / — only known fields are accepted server-side. */
      updateNotifications: (patch: Partial<NotificationSettingsWire>) =>
        api
          .request<NotificationSettingsWire>("PATCH", "/api/automations", patch)
          .then((r) => r.data),
      /** routes/auth.ts DELETE /account — the user and ALL their data, irreversibly (204). */
      deleteAccount: () => api.del<null>("/api/auth/account"),
    },
    push: {
      /**
       * routes/notifications.ts POST /push/device-token/register — FCM (Android) / APNs (iOS).
       * `dataMessages`: this Android build posts data-only mail pushes itself, with
       * buttons (android/.../push/KlornMessagingService.java), so the server may send them.
       */
      register: (token: string, platform: "ios" | "android") =>
        api.post<{ success: true }>("/api/notifications/push/device-token/register", {
          token,
          platform,
          ...(platform === "android" ? { dataMessages: true } : {}),
        }),
      /** routes/notifications.ts DELETE /push/device-token — on sign-out. */
      unregister: (token: string) =>
        api
          .request<null>("DELETE", "/api/notifications/push/device-token", { token })
          .then(() => undefined),
    },
    billing: {
      /** routes/billing.ts GET /status — the current plan (never a checkout link on native). */
      status: (o?: RequestOptions) => api.get<BillingStatusWire>("/api/billing/status", o),
    },
  };
}

export type Endpoints = ReturnType<typeof endpoints>;
