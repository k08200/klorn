"use client";

import { EmailFeedbackList } from "../../../components/email-feedback-list";
import FeedbackPolicyStudio from "../../../components/feedback-policy-studio";

export default function EmailFeedbackPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
      <header className="mb-5 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-2xl shadow-black/10">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
          Feedback Lab
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-50">메일 판단 교정 로그</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
          사용자가 고친 우선순위와 답장 필요 판단을 모아, EVE가 어떤 운영 규칙을 배워야 하는지
          확인합니다.
        </p>
      </header>

      <FeedbackPolicyStudio />
      <EmailFeedbackList />
    </div>
  );
}
