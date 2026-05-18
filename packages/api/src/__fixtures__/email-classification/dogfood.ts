import type { ClassifiedLabel } from "../../email-classifier.js";

export interface EmailClassificationFixture {
  id: string;
  note: string;
  from: string;
  subject: string;
  snippet: string;
  labels?: string[];
  expectedSyncPriority: "URGENT" | "NORMAL" | "LOW";
  expectedBatchLabel: ClassifiedLabel;
  knownHeuristicGap?: true;
}

export const dogfoodEmailClassificationFixtures: EmailClassificationFixture[] = [
  {
    id: "investor_reply_needs_same_day_review",
    note: "Investor/VC reply should not disappear as NORMAL when it asks for near-term review.",
    from: "Mina Park <mina@alpha-capital.com>",
    subject: "Re: Seed round follow-up",
    snippet: "Can you confirm the SAFE cap and pro-rata language by EOD tomorrow?",
    labels: ["INBOX", "UNREAD"],
    expectedSyncPriority: "URGENT",
    expectedBatchLabel: {
      priority: "high",
      category: "investor",
      needsReply: true,
      reason: "investor asks for deadline review",
    },
  },
  {
    id: "promo_urgent_discount_stays_low",
    note: "Marketing urgency language is not real user attention.",
    from: "marketing@brand.co.kr",
    subject: "긴급! 오늘만 50% 할인",
    snippet: "신규 가입 회원 한정 특별 할인입니다. 수신거부는 하단 링크.",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "promotional urgency",
    },
  },
  {
    id: "newsletter_action_required_stays_low",
    note: "Newsletter/action-required copy should not trigger urgent alerts.",
    from: "newsletter@saas.example",
    subject: "Action required: update your workspace tips",
    snippet: "Weekly product tips and recommended workflows. Unsubscribe anytime.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "newsletter sender",
    },
  },
  {
    id: "customer_contract_today_is_urgent",
    note: "Customer/prospect contract request with today deadline should be urgent.",
    from: "Jisoo Kim <jisoo@customer.co.kr>",
    subject: "계약서 오늘까지 회신 부탁드립니다",
    snippet: "내일 킥오프 전에 계약 조건 확인이 필요합니다.",
    labels: ["INBOX", "UNREAD"],
    expectedSyncPriority: "URGENT",
    expectedBatchLabel: {
      priority: "high",
      category: "customer",
      needsReply: true,
      reason: "customer deadline today",
    },
  },
  {
    id: "meeting_scheduling_is_normal",
    note: "Scheduling thread needs a reply, but it should not page as urgent.",
    from: "Minsoo <minsoo@partnerco.kr>",
    subject: "다음 주 미팅 일정 확인 부탁드립니다",
    snippet: "화요일 오후 3시에 가능하시면 캘린더 초대 보내드리겠습니다.",
    labels: ["INBOX", "UNREAD"],
    expectedSyncPriority: "NORMAL",
    expectedBatchLabel: {
      priority: "medium",
      category: "meeting",
      needsReply: true,
      reason: "scheduling reply needed",
    },
  },
  {
    id: "security_no_reply_does_not_need_reply",
    note: "Security/account email can be visible without becoming a reply-needed item.",
    from: "no-reply@accounts.example.com",
    subject: "Security alert: new sign-in",
    snippet: "We noticed a new sign-in from Chrome on macOS. If this was you, no action is needed.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "medium",
      category: "system",
      needsReply: false,
      reason: "security notification",
    },
  },

  // ─── Added 2026-05-19: dogfood pain "메일 부정확" coverage ─────────────
  {
    id: "donotreply_variants_are_automated",
    note: "donotreply@ / do-not-reply@ variants all collapse to automated.",
    from: "DoNotReply@bank.example",
    subject: "Statement available",
    snippet: "Your monthly statement is now available. Do not reply to this email.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "automated sender",
    },
  },
  {
    id: "korean_ad_marker_stays_low",
    note: "Korean [광고] subject marker is a regulatory tag — never urgent.",
    from: "Brand <hello@brand.co.kr>",
    subject: "[광고] 새 시즌 컬렉션이 도착했어요",
    snippet: "신상품 25% 할인 쿠폰을 드려요. 수신거부는 하단 링크.",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "Gmail promotions label",
    },
  },
  {
    id: "gmail_promotions_label_overrides_urgent_subject",
    note: "Even with action-required language, the Gmail promotions label wins.",
    from: "team@saas.example",
    subject: "Action required: your trial ends tomorrow",
    snippet: "Upgrade now to keep your data. View in your browser.",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "Gmail promotions label",
    },
  },
  {
    id: "view_in_browser_is_marketing",
    note: "'View in browser' is a near-perfect marketing tell — even without CATEGORY_PROMOTIONS.",
    from: "Hi from Brand <hi@brand.example>",
    subject: "Our biggest sale of the year — view in your browser",
    snippet: "Don't miss it. 30% off everything.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "marketing markers",
    },
  },
  {
    id: "korean_marketing_subject_pattern",
    note: "수신거부 / 무료 체험 / 할인 쿠폰 markers in subject = marketing.",
    from: "promo@somesite.kr",
    subject: "무료 체험 마지막 기회! 할인 쿠폰 안에",
    snippet: "지금 가입하면 30일 무료. 수신거부 가능.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "automated sender",
    },
  },
  {
    id: "korean_security_otp_not_a_reply",
    note: "Korean 보안/인증 from no-reply maps to system, never asks reply.",
    from: "noreply@account.kakao.com",
    subject: "[카카오] 본인 인증 코드 안내",
    snippet: "요청하신 인증번호는 123456 입니다. 인증번호는 5분간 유효합니다.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "medium",
      category: "system",
      needsReply: false,
      reason: "automated security notice",
    },
  },
  {
    id: "billing_invoice_no_reply",
    note: "Stripe-style invoice email is automated and low priority by default.",
    from: "invoice@stripe.example",
    subject: "Your invoice INV-0042 is available",
    snippet: "Receipt for May usage. Total $42.10.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "automated sender",
    },
  },
  {
    id: "bounce_postmaster_dropped",
    note: "Bounces from postmaster are automated — never a reply target.",
    from: "Mail Delivery System <MAILER-DAEMON@gmail.com>",
    subject: "Delivery Status Notification (Failure)",
    snippet: "Your message wasn't delivered to ... because the address couldn't be found.",
    labels: ["INBOX"],
    expectedSyncPriority: "LOW",
    expectedBatchLabel: {
      priority: "low",
      category: "automated",
      needsReply: false,
      reason: "automated sender",
    },
  },
] as const;
