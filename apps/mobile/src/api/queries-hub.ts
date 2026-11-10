/**
 * Query keys + hooks for Calendar, Assistant, Files, Accounts, Settings and
 * Plans. A flag-gated route that answers 404 (or /api/teams' 403
 * TEAM_REQUIRED) resolves to `null` — "this deployment does not have it" — so
 * the screen hides that source instead of showing an error.
 */
import { useQuery } from "@tanstack/react-query";
import { getServices } from "../app/services";
import { isApiError } from "./client";
import type { ImapKind } from "./endpoints";
import type { CalendarEventWire } from "./wire";

export const hk = {
  calendarWeek: (from: string, to: string) => ["calendar", "week", from, to] as const,
  calendarEvent: (id: string) => ["calendar", "event", id] as const,
  teams: ["calendar", "teams"] as const,
  teamSlots: (id: string, from: string, minutes: number) =>
    ["calendar", "team-slots", id, from, minutes] as const,
  conversations: ["assistant", "conversations"] as const,
  messages: (id: string) => ["assistant", "messages", id] as const,
  receipt: ["assistant", "receipt"] as const,
  driveFiles: (q: string, provider: string) => ["files", "drive", q, provider] as const,
  driveFile: (id: string) => ["files", "drive-file", id] as const,
  driveLimits: ["files", "limits"] as const,
  googleDrive: ["files", "google-accounts"] as const,
  attachmentMail: ["files", "attachment-mail"] as const,
  outlookInboxes: ["accounts", "outlook"] as const,
  imap: (kind: ImapKind) => ["accounts", "imap", kind] as const,
  linkedCalendars: (source: string) => ["accounts", "calendars", source] as const,
  notifications: ["settings", "notifications"] as const,
  billing: ["settings", "billing"] as const,
};

/** 404 (dark route) or 403 TEAM_REQUIRED / Pro-gated read: the feature is not here for this user. */
export function isUnavailable(err: unknown): boolean {
  return isApiError(err) && (err.status === 404 || err.status === 403);
}

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (isUnavailable(err)) return null;
    throw err;
  }
}

// ── Calendar ────────────────────────────────────────────────────────────────

export function useCalendarRange(start: Date, end: Date) {
  const from = start.toISOString();
  const to = end.toISOString();
  return useQuery({
    queryKey: hk.calendarWeek(from, to),
    queryFn: ({ signal }) =>
      getServices()
        .ep.calendar.events(start, end, { signal })
        .then((r) => (Array.isArray(r.events) ? r.events : [])),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useCalendarEvent(id: string | undefined, cached: CalendarEventWire | undefined) {
  return useQuery({
    queryKey: hk.calendarEvent(id ?? ""),
    queryFn: ({ signal }) => getServices().ep.calendar.event(id ?? "", { signal }),
    enabled: !!id && !cached,
    initialData: cached,
  });
}

export function useTeams(enabled = true) {
  return useQuery({
    queryKey: hk.teams,
    queryFn: ({ signal }) =>
      orNull(() => getServices().ep.teams.list({ signal })).then((r) => r?.teams ?? null),
    staleTime: 10 * 60_000,
    enabled,
  });
}

export function useTeamSlots(teamId: string | null, start: Date, end: Date, minutes: number) {
  return useQuery({
    queryKey: hk.teamSlots(teamId ?? "", start.toISOString(), minutes),
    queryFn: ({ signal }) =>
      getServices().ep.teams.availability(teamId ?? "", start, end, minutes, { signal }),
    enabled: !!teamId,
    staleTime: 60_000,
    meta: { persist: false },
  });
}

// ── Assistant ───────────────────────────────────────────────────────────────

export function useConversations() {
  return useQuery({
    queryKey: hk.conversations,
    queryFn: ({ signal }) =>
      getServices()
        .ep.assistant.conversations({ signal })
        .then((r) => (Array.isArray(r.conversations) ? r.conversations : [])),
    staleTime: 30_000,
  });
}

export function useChatMessages(id: string | null) {
  return useQuery({
    queryKey: hk.messages(id ?? "none"),
    queryFn: ({ signal }) =>
      getServices()
        .ep.assistant.messages(id ?? "", { signal })
        .then((r) => (Array.isArray(r.messages) ? r.messages : [])),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useReceipt() {
  return useQuery({
    queryKey: hk.receipt,
    queryFn: ({ signal }) => getServices().ep.assistant.receipt({ signal }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

// ── Files ───────────────────────────────────────────────────────────────────

/** The drive list (null: the drive is off on this deployment). */
export function useDriveFiles(q: string, provider: "KLORN" | "GOOGLE" | "" = "") {
  return useQuery({
    queryKey: hk.driveFiles(q.trim(), provider),
    queryFn: ({ signal }) =>
      orNull(() =>
        getServices().ep.files.list({ q, provider: provider || undefined, limit: 50 }, { signal }),
      ).then((r) => r?.files ?? null),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
}

/** One drive file with its summary (D4: absent while summaries are off). */
export function useDriveFile(id: string | null, enabled = true) {
  return useQuery({
    queryKey: hk.driveFile(id ?? ""),
    queryFn: ({ signal }) => getServices().ep.files.file(id ?? "", { signal }),
    enabled: !!id && enabled,
    staleTime: 5 * 60_000,
  });
}

export function useDriveLimits() {
  return useQuery({
    queryKey: hk.driveLimits,
    queryFn: ({ signal }) => orNull(() => getServices().ep.files.limits({ signal })),
    staleTime: 5 * 60_000,
    meta: { persist: false },
  });
}

export function useGoogleDriveAccounts() {
  return useQuery({
    queryKey: hk.googleDrive,
    queryFn: ({ signal }) =>
      orNull(() => getServices().ep.files.googleAccounts({ signal })).then(
        (r) => r?.accounts ?? null,
      ),
    staleTime: 5 * 60_000,
  });
}

/** How many attachment mails Files reads the attachments of (one detail read each). */
export const ATTACHMENT_MAIL_LIMIT = 8;

export interface AttachmentRow {
  id: string;
  emailId: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  summary: string | null;
  category: string | null;
  from: string;
  subject: string;
  date: string;
  inboxId: string | null;
}

/**
 * The "Mail attachments" source. The API has no attachment index, so this is
 * GET /api/email?filter=attachments, then GET /api/email/:id for the newest
 * few mails (bounded) — see README "Server gaps".
 */
export function useAttachmentFiles() {
  return useQuery({
    queryKey: hk.attachmentMail,
    queryFn: async ({ signal }) => {
      const { ep } = getServices();
      const list = await ep.files.attachmentMail(1, { signal });
      const mails = (list.emails ?? []).filter((e) => e.attachmentCount > 0);
      const details = await Promise.all(
        mails
          .slice(0, ATTACHMENT_MAIL_LIMIT)
          .map((m) => ep.files.attachmentsOf(m.id, { signal }).catch(() => null)),
      );
      const rows: AttachmentRow[] = [];
      details.forEach((detail, i) => {
        const mail = mails[i];
        if (!detail || !mail) return;
        for (const a of detail.attachments ?? []) {
          rows.push({
            id: a.id,
            emailId: mail.id,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            summary: a.summary,
            category: a.category,
            from: mail.from,
            subject: mail.subject,
            date: mail.date,
            inboxId: mail.linkedInboxAccountId,
          });
        }
      });
      return { rows, mails };
    },
    staleTime: 5 * 60_000,
  });
}

// ── Accounts ────────────────────────────────────────────────────────────────

export function useOutlookAvailable() {
  return useQuery({
    queryKey: hk.outlookInboxes,
    queryFn: ({ signal }) => orNull(() => getServices().ep.accounts.outlookInboxes({ signal })),
    staleTime: 10 * 60_000,
  });
}

export function useImapStatus(kind: ImapKind) {
  return useQuery({
    queryKey: hk.imap(kind),
    queryFn: ({ signal }) => orNull(() => getServices().ep.accounts.imapStatus(kind, { signal })),
    staleTime: 5 * 60_000,
  });
}

export function useLinkedCalendars(source: "google" | "outlook" | "caldav") {
  return useQuery({
    queryKey: hk.linkedCalendars(source),
    queryFn: ({ signal }) =>
      orNull(() => getServices().ep.accounts.linkedCalendars(source, { signal })).then(
        (r) => r?.accounts ?? null,
      ),
    staleTime: 5 * 60_000,
  });
}

// ── Settings · Plans ────────────────────────────────────────────────────────

export function useNotificationSettings() {
  return useQuery({
    queryKey: hk.notifications,
    queryFn: ({ signal }) => getServices().ep.settings.notifications({ signal }),
    staleTime: 60_000,
  });
}

export function useBillingStatus() {
  return useQuery({
    queryKey: hk.billing,
    queryFn: ({ signal }) => getServices().ep.billing.status({ signal }),
    staleTime: 60_000,
  });
}
