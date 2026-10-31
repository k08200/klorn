"use client";

import type { LiveTier } from "@klorn/contract";
import Link from "next/link";
import { forwardRef, useState } from "react";
import Button from "@/components/ui/button";
import { LANE_DOT_CLASS, LANE_INK_CLASS, LaneChip, useLaneName } from "@/components/ui/lane-chip";
import { useT } from "@/lib/i18n";
import { CORE_TIERS, toLiveTier } from "@/lib/tiers";
import { PRIMARY_LINK, START_URL } from "./chrome";
import {
  type DecidedExplanation,
  explainDecision,
  FEATURE_ORDER,
  type FeatureKey,
} from "./decided";
import { shortModelName } from "./models";
import { type FeedbackState, type SortedResult, sendFeedback } from "./use-classify";

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function Meter({
  feature,
  value,
  decided,
  lane,
}: {
  feature: FeatureKey;
  value: number;
  decided: boolean;
  lane: LiveTier;
}) {
  const { t } = useT();
  const v = clamp01(value);
  const name = t(`playground.feature.${feature}`);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-3 text-label">
        <span className={decided ? "font-semibold text-ink" : "font-medium text-ink"}>
          {name}
          {decided && (
            <span className={`font-medium ${LANE_INK_CLASS[lane]}`}>
              {" "}
              {t("playground.why.decided")}
            </span>
          )}
        </span>
        <span className="font-mono tabular-nums text-ink">{v.toFixed(2)}</span>
      </div>
      <div
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={v}
        aria-valuetext={`${v.toFixed(2)} (${t(`playground.feature.${feature}.low`)} 0 – ${t(`playground.feature.${feature}.high`)} 1)`}
        className="h-1.5 rounded-full bg-surface-inset"
      >
        <div
          className={`h-1.5 rounded-full ${decided ? LANE_DOT_CLASS[lane] : "bg-ink-mid"}`}
          style={{ width: `${Math.round(v * 100)}%` }}
        />
      </div>
      <div className="flex justify-between gap-3 text-caption text-ink-mid">
        <span>{t(`playground.feature.${feature}.low`)}</span>
        <span className="text-right">{t(`playground.feature.${feature}.high`)}</span>
      </div>
    </div>
  );
}

function WhyBlock({
  result,
  lane,
  explanation,
}: {
  result: SortedResult;
  lane: LiveTier;
  explanation: DecidedExplanation;
}) {
  const { t } = useT();
  const laneName = useLaneName();
  return (
    <div className="flex flex-col gap-3.5">
      <h3 className="text-caption font-semibold uppercase tracking-wide text-ink-mid">
        {t("playground.why.heading", { lane: laneName(lane) })}
      </h3>
      {explanation.noteKey && <p className="text-body text-ink-soft">{t(explanation.noteKey)}</p>}
      {FEATURE_ORDER.map((feature) => (
        <Meter
          key={feature}
          feature={feature}
          value={result.features[feature]}
          decided={explanation.drivers.includes(feature)}
          lane={lane}
        />
      ))}
    </div>
  );
}

function WrongLane({ result, lane }: { result: SortedResult; lane: LiveTier }) {
  const { t } = useT();
  const laneName = useLaneName();
  const [state, setState] = useState<FeedbackState>({ status: "idle" });
  const others = CORE_TIERS.filter((tier) => tier !== lane);

  async function pick(tier: LiveTier) {
    setState({ status: "sending", tier });
    const ok = await sendFeedback(result, tier);
    setState(ok ? { status: "sent", tier } : { status: "error" });
  }

  if (state.status === "sent") {
    return (
      <p role="status" className="text-label text-ink-soft">
        {t("playground.wrong.thanks", { lane: laneName(state.tier) })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-label text-ink-soft">{t("playground.wrong.prompt")}</span>
      <div className="flex flex-wrap gap-2">
        {others.map((tier) => (
          <Button
            key={tier}
            variant="chip"
            loading={state.status === "sending" && state.tier === tier}
            disabled={state.status === "sending"}
            onClick={() => pick(tier)}
            className={`${LANE_INK_CLASS[tier]} max-md:after:-inset-y-2`}
          >
            {laneName(tier)}
          </Button>
        ))}
      </div>
      {state.status === "error" && (
        <p role="alert" className="text-caption text-state-danger-ink">
          {t("playground.wrong.error")}
        </p>
      )}
    </div>
  );
}

interface ResultCardProps {
  result: SortedResult;
}

export const ResultCard = forwardRef<HTMLHeadingElement, ResultCardProps>(function ResultCard(
  { result },
  headingRef,
) {
  const { t } = useT();
  const lane = toLiveTier(result.tier);
  const explanation = explainDecision(result.decidedBy);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <LaneChip tier={lane} />
        <span className="text-caption text-ink-mid">
          {t("playground.meta", {
            model: shortModelName(result.model),
            seconds: result.seconds.toFixed(1),
          })}
        </span>
      </div>
      <div>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-title tracking-tight text-ink outline-none md:text-display"
        >
          {t(`playground.headline.${lane}`)}
        </h2>
        {result.reason && <p className="mt-2 text-body text-ink-soft">{result.reason}</p>}
      </div>
      <WhyBlock result={result} lane={lane} explanation={explanation} />
      <div className="flex flex-col gap-1 rounded-card bg-surface-raised px-4 py-3.5">
        <span className="text-caption font-semibold uppercase tracking-wide text-ink-mid">
          {t("playground.inKlorn.heading")}
        </span>
        <span className="text-body text-ink">{t(`playground.inKlorn.${lane}`)}</span>
      </div>
      <WrongLane key={`${result.tier}-${result.seconds}`} result={result} lane={lane} />
      <CtaRow />
    </div>
  );
});

function CtaRow() {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <span className="text-body text-ink-soft">{t("playground.cta.text")}</span>
      <Link href={START_URL} className={PRIMARY_LINK}>
        {t("playground.nav.startFree")}
      </Link>
    </div>
  );
}
