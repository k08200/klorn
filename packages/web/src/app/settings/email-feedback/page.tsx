"use client";

import AuthGuard from "../../../components/auth-guard";
import { EveSignalField } from "../../../components/brand-visuals";
import { EmailFeedbackList } from "../../../components/email-feedback-list";
import FeedbackPolicyStudio from "../../../components/feedback-policy-studio";

export default function EmailFeedbackPage() {
  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
        <header className="mb-5 overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
          <div className="h-1 bg-gradient-to-r from-amber-300 via-teal-300 to-stone-600" />
          <div className="grid gap-5 p-5 lg:grid-cols-[1fr_300px] lg:items-stretch">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                Feedback lab
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
                Mail judgment correction log
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
                Review corrected priority and reply-needed decisions so Jigeum can learn better
                operating rules.
              </p>
            </div>
            <EveSignalField className="min-h-40 rounded-lg" />
          </div>
        </header>

        <FeedbackPolicyStudio />
        <EmailFeedbackList />
      </div>
    </AuthGuard>
  );
}
