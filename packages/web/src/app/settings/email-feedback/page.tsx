"use client";

import { EveSignalField } from "../../../components/brand-visuals";
import { EmailFeedbackList } from "../../../components/email-feedback-list";
import FeedbackPolicyStudio from "../../../components/feedback-policy-studio";

export default function EmailFeedbackPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
      <header className="mb-5 overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
        <div className="h-1 bg-gradient-to-r from-amber-300 via-teal-300 to-stone-600" />
        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
              피드백 랩
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
              메일 판단 교정 로그
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
              사용자가 고친 우선순위와 답장 필요 판단을 모아, EVE가 어떤 운영 규칙을 배워야 하는지
              확인합니다.
            </p>
          </div>
          <EveSignalField className="min-h-40 rounded-lg" />
        </div>
      </header>

      <FeedbackPolicyStudio />
      <EmailFeedbackList />
    </div>
  );
}
