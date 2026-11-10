/**
 * Mail fixtures for the mock API — the rows, bodies and context of the Mail /
 * Reader / LaneSheet / Subscriptions / FoldOpen / TabletLandscape artboards,
 * so a mock screenshot compares one-to-one with the design. Times are relative
 * to `now` (fixture clock 10:28 KST). Typed against the wire contract.
 */
import type { EmailListItem, EmailReaderContextResponse, LiveTier } from "@klorn/contract";
import type {
  EmailDetailWire,
  EmailSubscriptionWire,
  ReplyDraftResponse,
  SenderDossierWire,
  ThreadBriefWire,
} from "../wire";
import { MOCK_USER } from "./fixtures";

const MIN = 60_000;
const DAY = 24 * 60;

export interface MailRow {
  id: string;
  from: string;
  subject: string;
  tier: LiveTier | null;
  ago: number;
  unread: boolean;
  inbox: string | null;
  summary: string;
  attachments?: number;
  needsReply?: boolean;
}

/** The artboards' rows, newest first, then older generated mail for paging. */
const DESIGN_ROWS: MailRow[] = [
  {
    id: "email-att-push-1",
    from: "박서연 · 한빛파트너스 <seoyeon@hanbitpartners.example>",
    subject: "계약서 수정본 — 오늘 서명 가능할까요?",
    tier: "PUSH",
    ago: 106,
    unread: true,
    inbox: "inbox-work",
    summary: "오늘 18시 마감, 회신 기다림",
    attachments: 1,
    needsReply: true,
  },
  {
    id: "email-att-meet-1",
    from: "Mark Chen <mark@capital.example>",
    subject: "Re: 투자 미팅 목요일 → 금요일?",
    tier: "MEETING",
    ago: 138,
    unread: true,
    inbox: "inbox-partners",
    summary: "목 14:00 회사 일정과 겹침",
    needsReply: true,
  },
  {
    id: "email-att-info-1",
    from: "한끼배달 <no-reply@hankki.example>",
    subject: "주문하신 음식이 배달 완료됐어요",
    tier: "INFO",
    ago: 153,
    unread: false,
    inbox: null,
    summary: "영수증 · 답장 불필요",
  },
  {
    id: "email-otjang-1",
    from: "옷장마켓 <news@otjang.example>",
    subject: "[광고] 가을 아우터 최대 70% — 오늘 자정까지",
    tier: "SILENT",
    ago: 300,
    unread: true,
    inbox: null,
    summary: "광고 · 기록만",
  },
  {
    id: "email-att-queue-1",
    from: "김도윤 <doyun@example.com>",
    subject: "포트폴리오 피드백 부탁드려요",
    tier: "QUEUE",
    ago: 968,
    unread: false,
    inbox: null,
    summary: "답장 필요 · 급하지 않음",
    needsReply: true,
  },
  {
    id: "email-moapay",
    from: "모아페이 <payments@moapay.example>",
    subject: "10월 결제 내역 안내",
    tier: "INFO",
    ago: 1224,
    unread: false,
    inbox: "inbox-naver",
    summary: "영수증 · 보관됨",
  },
  {
    id: "email-haeun-1",
    from: "이하은 <haeun@hanbit.example>",
    subject: "디자인 시스템 v2 리뷰 자료",
    tier: "QUEUE",
    ago: 3 * DAY + 300,
    unread: false,
    inbox: "inbox-work",
    summary: "첨부 2개 · 금요일까지",
    attachments: 2,
  },
  {
    id: "email-gureum-1",
    from: "구름보관함 <no-reply@gureum.example>",
    subject: "구름보관함 200GB 구독이 갱신되었습니다",
    tier: "INFO",
    ago: 3 * DAY + 420,
    unread: false,
    inbox: "inbox-icloud",
    summary: "갱신 알림",
  },
  {
    id: "email-minjun-1",
    from: "박민준 <minjun@hanbit.example>",
    subject: "다음 주 워크숍 장소 투표",
    tier: "QUEUE",
    ago: 4 * DAY + 120,
    unread: false,
    inbox: "inbox-work",
    summary: "답장 필요",
    needsReply: true,
  },
];

const OLDER: Array<Omit<MailRow, "id" | "ago">> = [
  {
    from: "새벽카드 <noreply@saebyeok.example>",
    subject: "9월 카드 사용 내역이 도착했어요",
    tier: "INFO",
    unread: false,
    inbox: null,
    summary: "명세서 · 답장 불필요",
  },
  {
    from: "최유진 <yujin@studio.example>",
    subject: "촬영 일정 조율 — 다음 주 화요일 가능하실까요?",
    tier: "MEETING",
    unread: false,
    inbox: "inbox-work",
    summary: "화 10:00 비어 있음",
  },
  {
    from: "빌드봇 <noreply@buildbot.example>",
    subject: "[klorn/app] CI passed on main",
    tier: "INFO",
    unread: false,
    inbox: "inbox-work",
    summary: "상태 알림",
  },
  {
    from: "정민호 <minho@partners.example>",
    subject: "견적서 검토 부탁드립니다",
    tier: "QUEUE",
    unread: false,
    inbox: "inbox-partners",
    summary: "첨부 1개 · 이번 주 안에",
  },
  {
    from: "누리항공 <noreply@nuriair.example>",
    subject: "예약이 확정되었습니다 — 11월 3일 ICN → NRT",
    tier: "INFO",
    unread: false,
    inbox: null,
    summary: "예약 확인",
  },
];

/** 9 design rows + 36 older rows, so Mail pages (mock page size 20). */
export function mailRows(now: number): MailRow[] {
  const older: MailRow[] = Array.from({ length: 36 }, (_, i) => {
    const base = OLDER[i % OLDER.length] as Omit<MailRow, "id" | "ago">;
    return { ...base, id: `email-older-${i + 1}`, ago: 5 * DAY + i * 260 };
  });
  void now;
  return [...DESIGN_ROWS, ...older];
}

function iso(now: number, offsetMin: number): string {
  return new Date(now + offsetMin * MIN).toISOString();
}

function addressOf(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

export function listItem(now: number, row: MailRow): EmailListItem {
  return {
    id: row.id,
    gmailId: `g-${row.id}`,
    threadId: `t-${row.id}`,
    linkedInboxAccountId: row.inbox,
    from: row.from,
    senderEmail: addressOf(row.from),
    trust: null,
    tier: row.tier,
    to: MOCK_USER.email,
    subject: row.subject,
    snippet: row.summary,
    date: iso(now, -row.ago),
    labels: ["INBOX"],
    isRead: !row.unread,
    isStarred: false,
    priority: row.tier === "PUSH" ? "URGENT" : "NORMAL",
    category: null,
    summary: row.summary,
    keyPoints: [],
    actionItems: [],
    sentiment: null,
    needsReply: row.needsReply ?? false,
    attachmentCount: row.attachments ?? 0,
    attachmentCandidateCount: 0,
    attachmentPendingCount: 0,
    attachmentFallbackCount: 0,
    attachmentUnsupportedCount: 0,
    attachmentCategories: [],
    candidateProfilePreview: null,
    candidateIntake: null,
  };
}

/** Why each design row sits in its lane (AttentionItem.tierReason). */
export const TIER_REASONS: Record<string, string> = {
  "email-att-push-1": "18시 마감을 두 번 적었고, 3주 동안 이 계약으로 6번 주고받은 사람이에요.",
  "email-att-meet-1": "목 14:00 회사 일정과 겹쳐요. 금 15:00는 세 캘린더 모두 비어 있어요.",
  "email-att-info-1": "배달 완료 영수증이에요. 답장할 필요가 없어요.",
  "email-att-queue-1": "답장이 필요하지만 오늘 안에 급하지 않아요.",
  "email-moapay": "결제 내역 안내예요. 기록으로 보관해요.",
  "email-haeun-1": "금요일까지 리뷰 요청 — 오늘 읽어 두면 좋아요.",
  "email-minjun-1": "팀 투표에 답장이 필요해요.",
  "email-otjang-1": "광고 메일이에요. 기록만 하고 보이지 않게 해요.",
};

const PUSH_HTML =
  '<div style="font-size:16px;line-height:1.65"><p>지수님,</p>' +
  "<p>어제 말씀하신 <b>3조</b>와 <b>7조</b> 수정 반영했습니다. 오늘 18시까지 서명해 주시면 다음 주 월요일부터 진행 가능합니다.</p>" +
  '<p>수정본은 첨부했고, 변경 이력은 <a href="https://docs.hanbitpartners.example/contract/v3">여기</a>에서도 보실 수 있어요.</p>' +
  "<p>확인 부탁드려요.<br>박서연 드림</p></div>";

const DELIVERY_HTML =
  '<table width="100%" bgcolor="#f4f5f7" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">' +
  '<table width="100%" bgcolor="#ffffff" style="max-width:520px;border-radius:12px" cellpadding="24"><tr><td>' +
  '<img src="https://img.hankki.example/logo.png" alt="한끼배달" width="120" height="32">' +
  '<h2 style="color:#111;font-size:20px;margin:16px 0 8px">배달이 완료됐어요</h2>' +
  '<p style="color:#444;font-size:15px">주문번호 3108-2210 · 한식당 온기</p>' +
  '<table width="100%" style="border-top:1px solid #eee;margin-top:12px"><tr><td style="color:#444;padding:8px 0">비빔밥 외 1건</td>' +
  '<td align="right" style="color:#111;font-weight:bold">18,500원</td></tr></table>' +
  '<p><a href="https://www.hankki.example/orders/3108-2210" style="color:#c2410c">주문 상세 보기</a></p>' +
  '<img src="https://t.hankki.example/open.gif?u=1" width="1" height="1" alt="">' +
  "</td></tr></table></td></tr></table>";

const MOAPAY_HTML =
  '<div style="background-color:#ffffff;color:#222;font-size:14px"><h3 style="color:#6d28d9">모아페이 10월 결제 내역</h3>' +
  "<p>10월 1일 ~ 10월 15일 결제 4건, 합계 <b>86,300원</b>입니다.</p>" +
  '<p><img src="https://static.moapay.example/pay/summary-chart.png" alt="결제 요약 그래프" width="320" height="120"></p></div>';

const PLAIN_BODIES: Record<string, string> = {
  "email-att-meet-1":
    "Hi Jisu,\n\nSomething came up on our side for Thursday 2pm. Would Friday afternoon work instead? Happy to do 3pm or 4pm your time.\n\nBest,\nMark",
  "email-att-queue-1":
    "지수님 안녕하세요! 지난번 말씀드린 포트폴리오 초안을 정리해서 보내드려요. 시간 되실 때 피드백 부탁드려도 될까요? 급하지는 않아요 :)",
  "email-haeun-1":
    "지수님, 디자인 시스템 v2 리뷰 자료 공유드려요. 금요일 리뷰 전에 한 번 훑어봐 주시면 좋겠어요.",
  "email-gureum-1": "구름보관함 200GB 구독이 갱신되었습니다. 다음 결제일은 2026년 11월 13일입니다.",
  "email-minjun-1": "다음 주 워크숍 장소 투표 부탁드려요. 성수 / 판교 / 온라인 중 골라 주세요.",
  "email-otjang-1": "가을 아우터 최대 70% 할인 — 오늘 자정까지.",
};

export function mockMailDetail(now: number, row: MailRow): EmailDetailWire {
  const item = listItem(now, row);
  const isPush = row.id === "email-att-push-1";
  return {
    id: item.id,
    gmailId: item.gmailId,
    threadId: item.threadId,
    from: row.from,
    senderEmail: item.senderEmail,
    to: MOCK_USER.email,
    cc: isPush ? "kim.legal@hanbit.example" : null,
    subject: row.subject,
    snippet: row.summary,
    body: isPush
      ? "지수님,\n\n어제 말씀하신 3조와 7조 수정 반영했습니다. 오늘 18시까지 서명해 주시면 다음 주 월요일부터 진행 가능합니다.\n\n확인 부탁드려요.\n박서연 드림"
      : (PLAIN_BODIES[row.id] ?? `${row.subject}\n\n${row.summary}`),
    renderHtml:
      row.id === "email-att-push-1"
        ? PUSH_HTML
        : row.id === "email-att-info-1"
          ? DELIVERY_HTML
          : row.id === "email-moapay"
            ? MOAPAY_HTML
            : null,
    date: item.date,
    isRead: item.isRead,
    isStarred: false,
    summary: row.summary,
    keyPoints: [],
    needsReply: row.needsReply ?? false,
    attachmentCount: row.attachments ?? 0,
    attachments: isPush
      ? [
          {
            id: "att-contract-v3",
            emailId: row.id,
            filename: "계약서_v3_한빛파트너스.pdf",
            mimeType: "application/pdf",
            size: 482_133,
            summary: "3조 지급 일정 2주 앞당김, 7조 해지 통보 30일 → 14일",
            category: "contract",
            analysisStatus: "done",
          },
        ]
      : row.id === "email-haeun-1"
        ? [
            {
              id: "att-ds-1",
              emailId: row.id,
              filename: "DS_v2_review.fig.pdf",
              mimeType: "application/pdf",
              size: 2_310_000,
              summary: null,
              category: null,
              analysisStatus: "pending",
            },
            {
              id: "att-ds-2",
              emailId: row.id,
              filename: "컴포넌트_목록.xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: 48_200,
              summary: null,
              category: null,
              analysisStatus: "pending",
            },
          ]
        : [],
    proactiveDraft: isPush
      ? "서연님, 수정본 확인했습니다. 3조·7조 모두 괜찮아요. 오늘 오후 4시 전에 서명해서 회신드릴게요."
      : null,
    tier: row.tier,
  };
}

export function mockReaderContext(
  rows: readonly MailRow[],
  id: string,
  tierOf: (row: MailRow) => LiveTier | null,
): EmailReaderContextResponse | null {
  const i = rows.findIndex((r) => r.id === id);
  const row = rows[i];
  if (!row) return null;
  return {
    tier: tierOf(row),
    tierReason: TIER_REASONS[row.id] ?? null,
    linkedInboxAccountId: row.inbox,
    firstContact: false,
    repliedCount: row.id === "email-att-push-1" ? 6 : null,
    // The contract's demo-mail value; the app does not render sender labels yet.
    senderLabel: null,
    newerId: rows[i - 1]?.id ?? null,
    olderId: rows[i + 1]?.id ?? null,
  };
}

export function mockThreadBrief(id: string): ThreadBriefWire | null {
  if (id === "email-att-push-1") {
    return {
      whyNow: "어제 요청하신 3조·7조 수정본을 보내며 오늘 18시 서명을 요청했어요.",
      asks: ["오늘 18시까지 서명", "수정본 확인"],
      weOwe: "서명한 계약서",
      theyOwe: null,
      stance: "확인했다고 답하고 서명 시간을 알려 주세요.",
      messageCount: 6,
      lastMessageAt: null,
    };
  }
  if (id === "email-att-meet-1") {
    return {
      whyNow: "목요일 14:00 미팅을 금요일 오후로 옮기자고 해요.",
      asks: ["금 15:00 또는 16:00 확정"],
      weOwe: "가능한 시간 회신",
      theyOwe: null,
      stance: null,
      messageCount: 3,
      lastMessageAt: null,
    };
  }
  return null;
}

export function mockSenderDossier(id: string): SenderDossierWire {
  if (id === "email-att-push-1") {
    return {
      summary: "한빛파트너스 계약 담당 · 3주간 메일 6번, 미팅 2번 · 보통 4시간 안에 회신",
      openThreads: ["계약서 v3 서명"],
      lastPromise: "지수님이 오늘 서명본을 보내기로 함",
      emailCount: 6,
      lastEmailAt: null,
    };
  }
  if (id === "email-att-meet-1") {
    return {
      summary: "Capital 파트너 · 투자 미팅 담당 · 이번 달 메일 3번",
      openThreads: ["투자 미팅 일정"],
      lastPromise: null,
      emailCount: 3,
      lastEmailAt: null,
    };
  }
  return { summary: "", openThreads: [], lastPromise: null, emailCount: 1, lastEmailAt: null };
}

const DRAFTS: Record<string, Record<string, string>> = {
  "email-att-push-1": {
    base: "서연님, 수정본 확인했습니다. 3조·7조 모두 괜찮아요. 오늘 오후 4시 전에 서명해서 회신드릴게요.",
    shorter: "서연님, 3조·7조 확인했어요. 오늘 4시 전에 서명해서 보낼게요.",
    politer:
      "서연님, 수정본 보내주셔서 감사합니다. 3조와 7조 모두 확인했고 문제없습니다. 오늘 오후 4시 전까지 서명하여 회신드리겠습니다.",
    english:
      "Hi Seoyeon, thanks for the revised draft. Clauses 3 and 7 both look good. I'll sign and send it back before 4pm today.",
  },
  "email-att-meet-1": {
    base: "Hi Mark, Friday at 3pm works for me — I'll move our meeting. See you then.",
    shorter: "Hi Mark, Friday 3pm works. See you then.",
    politer:
      "Hi Mark, thank you for letting me know. Friday at 3pm works well for me, and I'll update the invitation. Looking forward to it.",
    english: "Hi Mark, Friday at 3pm works for me — I'll move our meeting. See you then.",
  },
};

/** The draft for a mail; `intent` picks the tone-chip variant the mock knows. */
export function mockReplyDraft(row: MailRow, intent: string | undefined): ReplyDraftResponse {
  const set = DRAFTS[row.id] ?? {
    base: "확인했습니다. 곧 자세히 답장드릴게요.",
    shorter: "확인했어요.",
    politer: "보내주셔서 감사합니다. 확인 후 곧 자세히 답장드리겠습니다.",
    english: "Thanks — I'll get back to you shortly.",
  };
  const lower = (intent ?? "").toLowerCase();
  const key = lower.includes("short")
    ? "shorter"
    : lower.includes("polite") || lower.includes("formal")
      ? "politer"
      : lower.includes("english")
        ? "english"
        : "base";
  return {
    to: addressOf(row.from),
    subject: row.subject.startsWith("Re:") ? row.subject : `Re: ${row.subject}`,
    body: set[key] ?? set.base ?? "",
  };
}

// ── Subscriptions ───────────────────────────────────────────────────────────

const SUBS: Array<[string, string | null, string | null, number, number]> = [
  // sender, displayName, linkedInboxAccountId, count, read
  // Fictional senders only (no real brand in a screenshot).
  ["news@otjang.example", "옷장마켓", null, 64, 1],
  ["notifications@careernote.example", "커리어노트 알림", "inbox-work", 51, 3],
  ["noreply@geulmaru.example", "글마루 데일리", "inbox-naver", 32, 0],
  ["ads@hankki.example", "한끼배달 광고", null, 30, 1],
  ["benefit@saebyeok.example", "새벽카드 혜택", null, 28, 20],
  ["news@modernshop.example", "모던편집숍", null, 24, 1],
  ["digest@jilmun.example", "질문광장 다이제스트", "inbox-work", 22, 0],
  ["promo@ieumbooks.example", "책방이음", "inbox-naver", 18, 1],
  ["deal@oneulmarket.example", "오늘마켓 특가", null, 17, 0],
  ["hello@memopan.example", "메모판", "inbox-work", 15, 9],
  ["letter@woorijip.example", "우리집꾸미기", null, 14, 1],
  ["news@saebyeokjang.example", "새벽장보기", null, 12, 0],
  ["weekly@geulbat.example", "글밭 위클리", "inbox-naver", 11, 1],
  ["event@ongicoffee.example", "온기커피", null, 10, 0],
  ["team@drawingboard.example", "드로잉보드", "inbox-work", 9, 6],
  ["news@chaeksup.example", "책숲", null, 8, 1],
];

const ACCOUNT_LABELS: Record<string, string> = {
  "inbox-work": "jisu@hanbit.example",
  "inbox-naver": "jisu@naver.example",
};

export function mockSubscriptions(now: number): EmailSubscriptionWire[] {
  return SUBS.map(([sender, displayName, account, count, read], i) => ({
    sender,
    displayName,
    linkedInboxAccountId: account,
    accountLabel: account ? (ACCOUNT_LABELS[account] ?? null) : "jisu.shin@gmail.example",
    count,
    unreadCount: count - read,
    lastReceivedAt: iso(now, -(i + 1) * 300),
    method: sender.startsWith("weekly@") ? "link" : i % 3 === 2 ? "mailto" : "one-click",
  }));
}
