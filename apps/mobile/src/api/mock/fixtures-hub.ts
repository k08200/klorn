/**
 * Fixtures for Calendar, Assistant, Files, Accounts, Settings and Plans — the
 * approved Calendar / Assistant / Files / Accounts artboards, one-to-one.
 * Calendar times are wall-clock times in Asia/Seoul in the week of `now`
 * (fixture clock: Thursday 2026-10-16 10:28 KST), so a fixed clock gives a
 * fixed picture and `dev:mock` with a real clock still looks like a real week.
 *
 * Typed against the real wire contract: if the server shape changes, these
 * stop compiling.
 */
import type {
  DailyReceipt,
  DriveFileWire,
  DriveLimitsResponse,
  EmailListItem,
  GoogleDriveAccountWire,
  TeamAvailabilityResponse,
  TeamWire,
} from "@klorn/contract";
import type {
  AttachmentMailWire,
  BillingStatusWire,
  CalendarEventWire,
  ChatMessageWire,
  ConversationWire,
  EmailAttachmentWire,
  EmailDetailWire,
  ImapStatusWire,
  LinkedCalendarsResponse,
  NotificationSettingsWire,
} from "../wire";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const KST_OFFSET = 9 * 60 * MIN;

/** Midnight (KST) of the day `dayOffset` days from `now`'s KST day. */
function kstMidnight(now: number, dayOffset = 0): number {
  return Math.floor((now + KST_OFFSET) / DAY) * DAY - KST_OFFSET + dayOffset * DAY;
}

function wall(now: number, dayOffset: number, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(kstMidnight(now, dayOffset) + ((h ?? 0) * 60 + (m ?? 0)) * MIN).toISOString();
}

// ── Calendar ────────────────────────────────────────────────────────────────

const WORK = { provider: "GOOGLE", sourceAccountId: "cal-work", sourceLabel: "회사 캘린더" };
const PARTNERS = {
  provider: "GOOGLE",
  sourceAccountId: "cal-partners",
  sourceLabel: "파트너스 캘린더",
};
const ICLOUD = { provider: "ICLOUD", sourceAccountId: "cal-icloud", sourceLabel: "iCloud" };
const PERSONAL = { provider: "GOOGLE", sourceAccountId: null };

/**
 * The Calendar artboard's days, relative to `now`'s KST day: busy three and two
 * days before, today (five events, one conflict) and tomorrow; the day before is free.
 */
export function mockWeekEvents(now: number): CalendarEventWire[] {
  const ev = (
    id: string,
    day: number,
    start: string,
    end: string,
    title: string,
    source: Record<string, unknown>,
    extra: Partial<CalendarEventWire> = {},
  ): CalendarEventWire => ({
    id,
    title,
    startTime: wall(now, day, start),
    endTime: wall(now, day, end),
    location: null,
    allDay: false,
    ...(source as Partial<CalendarEventWire>),
    ...(source.sourceAccountId ? { readOnly: true as const } : {}),
    ...extra,
  });
  return [
    ev("evt-weekly", -3, "10:00", "11:00", "주간 계획", WORK, {
      meetingLink: "https://meet.google.com/wkl-plan-mon",
    }),
    ev("evt-interview", -3, "15:00", "16:00", "채용 인터뷰 — 프로덕트 디자이너", WORK),
    ev("evt-partner", -2, "13:00", "14:00", "파트너 정기 콜", PARTNERS, {
      meetingLink: "https://meet.google.com/ptn-week-call",
    }),
    ev("evt-standup", 0, "09:30", "10:00", "팀 스탠드업", WORK, {
      meetingLink: "https://meet.google.com/std-daily-up",
    }),
    ev("evt-review", 0, "11:00", "12:00", "디자인 리뷰 — 모바일 v1", WORK, {
      meetingLink: "https://meet.google.com/abc-defg-hij",
      description: "모바일 v1 시안 최종 검토. 캘린더·파일·도우미 화면을 함께 봐요.",
    }),
    ev("evt-lunch", 0, "12:30", "13:30", "점심 — 민지", ICLOUD, { location: "성수동" }),
    ev("evt-investor", 0, "14:00", "15:00", "투자사 미팅 · Mark Chen", PARTNERS, {
      meetingLink: "https://meet.google.com/inv-mark-chen",
      location: "강남 사무실",
    }),
    ev("evt-1on1", 0, "14:30", "15:00", "하은 님 1:1", WORK),
    ev("evt-doctor", 1, "10:30", "11:30", "병원 예약", PERSONAL, { location: "연세정형외과" }),
    ev("evt-dinner", 1, "18:30", "20:00", "가족 저녁", ICLOUD),
  ];
}

/** Events in [start, end) — what GET /api/calendar?start=&end= answers. */
export function eventsInRange(
  events: readonly CalendarEventWire[],
  start: string | null,
  end: string | null,
): CalendarEventWire[] {
  const from = start ? Date.parse(start) : Number.NEGATIVE_INFINITY;
  const to = end ? Date.parse(end) : Number.POSITIVE_INFINITY;
  return events.filter((e) => {
    const at = Date.parse(e.startTime);
    return at >= from && at <= to;
  });
}

export const MOCK_TEAMS: TeamWire[] = [
  {
    id: "team-design",
    name: "디자인팀",
    members: ["minjun@hanbit.example", "haeun@hanbit.example", "doyun@hanbit.example"],
  },
];

export function mockTeamAvailability(now: number): TeamAvailabilityResponse {
  return {
    slots: [
      { startTime: wall(now, 5, "10:00"), endTime: wall(now, 5, "11:00") },
      { startTime: wall(now, 6, "14:00"), endTime: wall(now, 6, "15:00") },
      { startTime: wall(now, 7, "16:00"), endTime: wall(now, 7, "17:00") },
    ],
    checkedMembers: ["minjun@hanbit.example", "haeun@hanbit.example", "doyun@hanbit.example"],
    unknownMembers: [],
    timeZone: "Asia/Seoul",
  };
}

// ── Assistant ───────────────────────────────────────────────────────────────

export const MOCK_CONVERSATION: ConversationWire = {
  id: "conv-design",
  title: "다음 주에 디자인팀이랑 1시간 회의 잡아줘",
  updatedAt: "2026-10-16T01:20:00.000Z",
};

export function mockChatMessages(now: number): ChatMessageWire[] {
  return [
    {
      id: "msg-1",
      role: "USER",
      content: "다음 주에 디자인팀이랑 1시간 회의 잡아줘. 다들 되는 시간으로.",
      metadata: { source: "chat" },
      createdAt: new Date(now - 8 * MIN).toISOString(),
    },
    {
      id: "msg-2",
      role: "ASSISTANT",
      content:
        "민준·하은·도윤 님의 캘린더를 확인했어요. 네 명 모두 비어 있는 시간은 세 개예요. 그중 21일 10시가 모두 그날 첫 일정이라 가장 좋아요.",
      metadata: {
        source: "chat",
        eventDraft: {
          title: "디자인팀 회의",
          startTime: wall(now, 5, "10:00"),
          endTime: wall(now, 5, "11:00"),
          attendees: ["minjun@hanbit.example", "haeun@hanbit.example", "doyun@hanbit.example"],
        },
      },
      createdAt: new Date(now - 7 * MIN).toISOString(),
    },
  ];
}

export function mockReceipt(now: number, empty = false): DailyReceipt {
  const at = (h: string) => wall(now, 0, h);
  const item = (
    id: string,
    title: string,
    source: string,
    type: string,
    time: string,
    reason: string | null,
  ) => ({
    id,
    title,
    source,
    type,
    tierReason: reason,
    surfacedAt: at(time),
  });
  if (empty) {
    return {
      date: new Date(kstMidnight(now) + KST_OFFSET).toISOString().slice(0, 10),
      silenced: [],
      queued: [],
      pushed: [],
      auto: [],
      summary: {
        totalSeen: 0,
        totalInterrupted: 0,
        savedFromInbox: 0,
        autoHandled: 0,
        narrative: "",
      },
    };
  }
  return {
    date: new Date(kstMidnight(now) + KST_OFFSET).toISOString().slice(0, 10),
    pushed: [
      {
        ...item(
          "r-push-1",
          "박서연 님이 계약서 회신을 기다려요",
          "EMAIL",
          "REPLY_NEEDED",
          "08:42",
          "오늘 18시 마감 · 두 번 언급",
        ),
        pushStatus: "delivered",
      },
      item(
        "r-push-2",
        "목 14:00 투자사 미팅이 겹쳐요",
        "EMAIL",
        "DECISION",
        "08:10",
        "회사·파트너스 캘린더 충돌",
      ),
    ],
    queued: [
      item(
        "r-queue-1",
        "김도윤 님의 포트폴리오 피드백 요청",
        "EMAIL",
        "REPLY_NEEDED",
        "07:55",
        "답장 필요 · 급하지 않음",
      ),
    ],
    auto: [
      item(
        "r-auto-1",
        "create task",
        "PENDING_ACTION",
        "AGENT_PROPOSAL",
        "09:05",
        "Auto-executed — low risk, pre-approved",
      ),
    ],
    silenced: [
      item(
        "r-silent-1",
        "뉴스레터 3통",
        "EMAIL",
        "DECISION",
        "06:30",
        "구독 메일 · 읽지 않아도 됨",
      ),
      item("r-silent-2", "한끼배달 광고", "EMAIL", "DECISION", "01:12", "광고"),
    ],
    summary: {
      totalSeen: 48,
      totalInterrupted: 2,
      savedFromInbox: 41,
      autoHandled: 1,
      narrative: "오늘 메일 48통 중 2통만 알려드렸고, 41통은 조용히 정리했어요.",
    },
  };
}

// ── Files ───────────────────────────────────────────────────────────────────

export const MOCK_DRIVE_FILES: DriveFileWire[] = [
  {
    id: "drv-budget",
    provider: "GOOGLE",
    sourceKey: "gdrive-work",
    externalId: "1AbCbudget",
    name: "2026 Q4 예산.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    isFolder: false,
    sizeBytes: 48_213,
    parentExternalId: null,
    modifiedAt: "2026-10-14T05:12:00.000Z",
    webUrl: "https://docs.google.com/spreadsheets/d/1AbCbudget/edit",
    readOnly: true,
  },
  {
    id: "drv-ir",
    provider: "KLORN",
    sourceKey: "klorn",
    externalId: "k-ir-deck",
    name: "투자 IR 덱 10월.key",
    mimeType: "application/x-iwork-keynote-sffkey",
    isFolder: false,
    sizeBytes: 18_402_113,
    parentExternalId: null,
    modifiedAt: "2026-10-13T02:40:00.000Z",
    webUrl: null,
    readOnly: false,
  },
];

export const MOCK_DRIVE_SUMMARIES: Record<string, string> = {
  "drv-budget": "마케팅 18% 증액, 채용 2명이 반영된 버전.",
  "drv-ir": "지표 슬라이드 4–7번을 업데이트해야 한다는 메모가 있어요.",
};

export const MOCK_DRIVE_LIMITS: DriveLimitsResponse = {
  maxFileBytes: 26_214_400,
  quotaBytes: 10 * 1024 ** 3,
  usedBytes: Math.round(2.1 * 1024 ** 3),
};

export const MOCK_GOOGLE_DRIVE_ACCOUNTS: GoogleDriveAccountWire[] = [
  {
    id: "gdrive-work",
    email: "jisu@hanbit.example",
    needsReconnect: false,
    createdAt: "2026-09-02T00:00:00.000Z",
  },
];

interface AttachmentMail {
  email: AttachmentMailWire & { linkedInboxAccountId: string | null };
  categories: string[];
}

/** Mail with attachments this week (the summary card: 7 attachments · 2 contracts · 3 résumés · 2 receipts). */
export function mockAttachmentMail(now: number): AttachmentMail[] {
  const att = (
    id: string,
    emailId: string,
    filename: string,
    mimeType: string,
    size: number,
    summary: string | null,
    category: string,
  ): EmailAttachmentWire => ({
    id,
    emailId,
    filename,
    mimeType,
    size,
    summary,
    category,
    analysisStatus: summary ? "done" : "pending",
  });
  const mail = (
    id: string,
    from: string,
    subject: string,
    agoMin: number,
    inbox: string | null,
    attachments: EmailAttachmentWire[],
  ): AttachmentMail => ({
    email: {
      id,
      from,
      subject,
      date: new Date(now - agoMin * MIN).toISOString(),
      attachments,
      linkedInboxAccountId: inbox,
    },
    categories: [...new Set(attachments.map((a) => a.category ?? "other"))],
  });
  return [
    mail(
      "email-contract",
      "박서연 <seoyeon@hanbitpartners.example>",
      "계약서 수정본 — v3",
      106,
      "inbox-work",
      [
        att(
          "att-contract-v3",
          "email-contract",
          "계약서_v3_한빛파트너스.pdf",
          "application/pdf",
          412_000,
          "3조 지급 일정 2주 단축, 7조 해지 통보 14일로 변경. 서명 마감 오늘 18시.",
          "contract",
        ),
        att(
          "att-contract-redline",
          "email-contract",
          "계약서_v3_변경사항.pdf",
          "application/pdf",
          188_000,
          "v2 대비 바뀐 조항 3·7·12조를 표시한 비교본.",
          "contract",
        ),
      ],
    ),
    mail(
      "email-resume",
      "김도윤 <doyun@example.com>",
      "프로덕트 디자이너 지원합니다",
      1_380,
      "inbox-work",
      [
        att(
          "att-resume-kim",
          "email-resume",
          "이력서_김도윤.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          96_000,
          "프로덕트 디자이너 5년, 핀테크 앱 2개 출시. 포트폴리오 링크 포함.",
          "resume",
        ),
      ],
    ),
    mail(
      "email-applicants",
      "원티드 <noreply@wanted.example>",
      "새 지원자 2명",
      1_500,
      "inbox-work",
      [
        att(
          "att-resume-lee",
          "email-applicants",
          "이력서_이서준.pdf",
          "application/pdf",
          210_000,
          "UX 리서처 3년, 정성 인터뷰 설계 경험.",
          "resume",
        ),
        att(
          "att-resume-park",
          "email-applicants",
          "이력서_박하린.pdf",
          "application/pdf",
          175_000,
          "그래픽 디자이너 4년, 브랜드 리뉴얼 프로젝트 리드.",
          "resume",
        ),
      ],
    ),
    mail(
      "email-receipt",
      "모아페이 <no-reply@moapay.example>",
      "10월 결제 내역 안내",
      2_880,
      "inbox-naver",
      [
        att(
          "att-receipt-oct",
          "email-receipt",
          "10월_결제내역.pdf",
          "application/pdf",
          64_000,
          "10월 결제 12건, 합계 384,200원.",
          "invoice",
        ),
        att(
          "att-receipt-delivery",
          "email-receipt",
          "한끼배달_영수증.png",
          "image/png",
          120_000,
          "배달 영수증 23,500원.",
          "invoice",
        ),
      ],
    ),
  ];
}

/** GET /api/email?filter=attachments — the list items for the attachment mail. */
export function mockAttachmentList(now: number): EmailListItem[] {
  return mockAttachmentMail(now).map(({ email, categories }) => ({
    id: email.id,
    gmailId: `g-${email.id}`,
    threadId: `t-${email.id}`,
    linkedInboxAccountId: email.linkedInboxAccountId,
    from: email.from,
    senderEmail: null,
    trust: null,
    tier: "QUEUE",
    to: "jisu@hanbit.example",
    subject: email.subject,
    snippet: null,
    date: email.date,
    labels: ["INBOX"],
    isRead: true,
    isStarred: false,
    priority: "NORMAL",
    category: null,
    summary: null,
    keyPoints: [],
    actionItems: [],
    sentiment: null,
    needsReply: false,
    attachmentCount: email.attachments?.length ?? 0,
    attachmentCandidateCount: 0,
    attachmentPendingCount: 0,
    attachmentFallbackCount: 0,
    attachmentUnsupportedCount: 0,
    attachmentCategories: categories,
    candidateProfilePreview: null,
    candidateIntake: null,
  }));
}

/** GET /api/email/:id for an attachment mail: the reader's fields plus `attachments`. */
export function mockAttachmentDetail(
  now: number,
  id: string,
): (EmailDetailWire & AttachmentMailWire) | null {
  const found = mockAttachmentMail(now).find((m) => m.email.id === id);
  if (!found) return null;
  const { email } = found;
  return {
    id: email.id,
    gmailId: `g-${email.id}`,
    threadId: `t-${email.id}`,
    from: email.from,
    senderEmail: null,
    to: "jisu@hanbit.example",
    subject: email.subject,
    snippet: null,
    body: "첨부 파일을 확인해 주세요.",
    date: email.date,
    isRead: true,
    isStarred: false,
    summary: null,
    keyPoints: [],
    needsReply: false,
    attachmentCount: email.attachments?.length ?? 0,
    tier: "QUEUE",
    attachments: email.attachments ?? [],
  };
}

// ── Accounts · Settings · Plans ─────────────────────────────────────────────

export function mockImapStatus(kind: "naver" | "icloud" | "generic"): ImapStatusWire {
  const accounts =
    kind === "naver"
      ? [
          {
            email: "jisu@naver.example",
            host: "imap.naver.com",
            connectedAt: "2026-09-12T00:00:00.000Z",
            lastSyncedAt: "2026-10-16T01:20:00.000Z",
            needsReconnect: false,
          },
        ]
      : kind === "icloud"
        ? [
            {
              email: "jisu@icloud.example",
              host: "imap.mail.me.com",
              connectedAt: "2026-09-20T00:00:00.000Z",
              lastSyncedAt: null,
              needsReconnect: true,
            },
          ]
        : [];
  return { canConnect: true, connected: accounts.length > 0, accounts };
}

export const MOCK_LINKED_CALENDARS: Record<
  "google" | "outlook" | "caldav",
  LinkedCalendarsResponse
> = {
  google: {
    accounts: [
      {
        id: "cal-work",
        email: "jisu@hanbit.example",
        displayName: "회사 캘린더",
        needsReconnect: false,
      },
      {
        id: "cal-partners",
        email: "jisu@partners.example",
        displayName: "파트너스 캘린더",
        needsReconnect: false,
      },
    ],
  },
  // No Outlook account connected: Outlook is dark in production, so the
  // fixtures (and every screenshot) show none. The route still answers, so the
  // "add Outlook" option behaves as with OUTLOOK_INBOX_ENABLED on.
  outlook: { accounts: [] },
  caldav: {
    accounts: [
      { id: "cal-icloud", email: "jisu@icloud.example", provider: "ICLOUD", needsReconnect: false },
    ],
  },
};

export const MOCK_NOTIFICATION_SETTINGS: NotificationSettingsWire = {
  notifyEmailUrgent: true,
  notifyMeeting: true,
  notifyAgentProposal: true,
  notifyDailyBriefing: true,
  notifyTaskDue: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  notificationLanguage: "ko",
  notificationLanguages: ["en", "ko", "ja", "zh", "es", "fr", "de"],
  timezone: "Asia/Seoul",
};

export const MOCK_BILLING: BillingStatusWire = {
  plan: "PRO",
  planName: "Pro",
  subscriptionStatus: "active",
  renewsAt: "2026-11-02T00:00:00.000Z",
  cancelAt: null,
  messageLimit: null,
  messageCount: 42,
};
