"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";
import { useToast } from "./toast";

type PmfAnswer = "VERY" | "SOMEWHAT" | "NOT";

/** Remembers a "not now" so the probe does not reappear on every navigation. */
const DISMISS_KEY = "klorn.pmf.dismissed";

/**
 * PMF probe — the read-and-answer surface for `product/cohort.ts` (#1234).
 *
 * That PR shipped the eligibility rules, the store and the summary, and said
 * plainly: "No UI for the probe, so nothing is collected until one exists."
 * The pricing decision in the launch plan is gated on a number this produces,
 * so every day without this is a day of eligible users walking past ungathered.
 *
 * Four properties inherited from the server, none of which may be softened:
 *
 *   1. **The server decides who is asked, not this.** Eligibility is 7 days of
 *      tenure plus 20 judged decisions, evaluated server-side and returned as a
 *      single boolean. No thresholds are duplicated here — a second copy of a
 *      rule is a second answer waiting to disagree with the first.
 *
 *   2. **Asked once.** The server refuses anyone who has already answered, and
 *      a local dismissal covers "not now" without a second write path. Nagging
 *      is how you convert a measurement into an annoyance, and an annoyed
 *      answer is worse data than no answer.
 *
 *   3. **The write does not fail open.** `POST /api/pmf/response` returns 500
 *      rather than pretending. Someone who answers and sees no error assumes
 *      they were counted; if they were not, the number the pricing decision
 *      rests on is quietly wrong. So a failure leaves the question standing and
 *      says so.
 *
 *   4. **Three options, never four.** The Sean Ellis question is only
 *      comparable because everyone asks it the same way. Adding a neutral
 *      middle or a free-text box would produce a number that looks like the
 *      benchmark and is not one.
 *
 * Renders nothing unless the server says this user is eligible — including when
 * the flag is off, which is simply `eligible: false`.
 */
export default function PmfCard() {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [answering, setAnswering] = useState<PmfAnswer | null>(null);
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1",
  );

  // Any failure resolves to "not eligible" and renders nothing. A survey is the
  // most optional thing on this screen; an error box in its place would cost
  // more attention than the answer is worth.
  const { data: eligible } = useQuery({
    queryKey: queryKeys.pmf.eligible(),
    queryFn: async (): Promise<boolean> => {
      try {
        const res = await apiFetch<{ eligible: boolean }>("/api/pmf/eligible");
        return Boolean(res.eligible);
      } catch (err) {
        captureClientError(err, { scope: "pmf.eligible" });
        return false;
      }
    },
  });

  const answer = useMutation({
    mutationFn: (value: PmfAnswer) =>
      apiFetch<{ ok: true }>("/api/pmf/response", {
        method: "POST",
        body: JSON.stringify({ answer: value }),
      }),
    onMutate: (value: PmfAnswer) => setAnswering(value),
    onSuccess: () => {
      // Only on a confirmed write. Hiding the card optimistically would tell a
      // user they were counted when a 500 means they were not.
      queryClient.setQueryData(queryKeys.pmf.eligible(), false);
      toast(t("pmf.thanks"), "success");
    },
    onError: (err) => {
      captureClientError(err, { scope: "pmf.response" });
      toast(t("pmf.failed"), "error");
    },
    onSettled: () => setAnswering(null),
  });

  if (!eligible || dismissed) return null;

  const options: { value: PmfAnswer; label: string }[] = [
    { value: "VERY", label: t("pmf.very") },
    { value: "SOMEWHAT", label: t("pmf.somewhat") },
    { value: "NOT", label: t("pmf.not") },
  ];

  return (
    <section
      data-testid="pmf-card"
      aria-labelledby="pmf-heading"
      className="panel-elevated mb-4 rounded-2xl border border-line/70 bg-surface-panel p-5"
    >
      <h2 id="pmf-heading" className="text-base font-semibold text-ink">
        {t("pmf.title")}
      </h2>
      <p className="mt-1.5 text-label font-normal leading-5 text-ink-mid">{t("pmf.subtitle")}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={answering !== null}
            onClick={() => answer.mutate(opt.value)}
            className="focus-ring inline-flex min-h-11 items-center rounded-lg border border-line px-3.5 text-xs font-semibold text-ink transition hover:border-line-strong hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {answering === opt.value ? t("pmf.working") : opt.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          window.localStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
        className="focus-ring mt-3 inline-flex min-h-11 items-center text-caption font-medium text-ink-dim hover:underline"
      >
        {t("pmf.later")}
      </button>
    </section>
  );
}
