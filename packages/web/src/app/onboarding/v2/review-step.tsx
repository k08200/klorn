"use client";

/**
 * First run, step 3 — "Check Klorn's sorting" (productization plan P8). A few
 * of the user's own mails with the lane each landed in, and a one-tap way to
 * agree or to move one.
 *
 * It reuses the review step's reads and writes (use-firewall-emails). With
 * KEYBOARD_TRIAGE on, a move goes through the reversible override instead
 * (use-lane-move) and can be undone for a few seconds. Either way a move is a
 * reclassification: nothing is sent, archived or deleted.
 */

import type { FirewallItem, LiveTier } from "@klorn/contract";
import { useEffect, useState } from "react";
import Button from "../../../components/ui/button";
import { LaneChip } from "../../../components/ui/lane-chip";
import { Skeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { CORE_TIERS, toLiveTier } from "../../../lib/tiers";
import { useLaneMove } from "../../email/use-lane-move";
import { type Label, useFirewallEmails, useFirewallLabels } from "../use-firewall-emails";
import { growSample } from "./model";

export function ReviewStepV2({ onContinue }: { onContinue: () => void }) {
  const { t } = useT();
  const { user } = useAuth();
  const reversible = user?.keyboardTriage === true;
  const { items, loading, loadError } = useFirewallEmails();
  const { labels, pending, label } = useFirewallLabels();
  // Lanes moved through the reversible override, by email id.
  const [moved, setMoved] = useState<ReadonlyMap<string, LiveTier>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const laneMove = useLaneMove({
    // A null lane is "put back what was there": the mail is no longer moved.
    apply: (emailId, tier) =>
      setMoved((prev) => {
        const next = new Map(prev);
        if (tier === null) next.delete(emailId);
        else next.set(emailId, tier);
        return next;
      }),
    onError: setError,
  });

  // Rows already shown stay put while classification keeps trickling in.
  const [sample, setSample] = useState<FirewallItem[]>([]);
  useEffect(() => {
    setSample((shown) => growSample(shown, items));
  }, [items]);
  // Read through Maps: an id is server data and never indexes an object.
  const labelById = new Map(Object.entries(labels));
  const pendingById = new Map(Object.entries(pending));
  const labelFor = (item: FirewallItem): Label | undefined => labelById.get(item.id);
  const isPending = (item: FirewallItem): boolean => pendingById.get(item.id) === true;

  const move = (item: FirewallItem, lane: LiveTier) => {
    setError(null);
    if (!reversible) {
      void label(item, lane);
      return;
    }
    const shown = moved.get(item.sourceId) ?? toLiveTier(item.tier);
    laneMove.move(
      { id: item.sourceId, subject: item.email?.subject ?? item.title, tier: shown },
      lane,
    );
  };

  return (
    <section aria-labelledby="onboarding-review-title">
      <h1 id="onboarding-review-title" tabIndex={-1} className="text-display text-ink outline-none">
        {t("onboardingV2.review.title")}
      </h1>
      <p className="mt-2 max-w-xl text-body text-ink-mid">{t("onboardingV2.review.body")}</p>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-card border border-state-danger-line bg-state-danger-bg px-4 py-3 text-body text-state-danger-ink"
        >
          {error}
        </p>
      )}

      {loading && sample.length === 0 ? (
        <SkeletonGroup
          label={t("onboardingV2.review.loading")}
          className="mt-6 flex flex-col gap-3"
        >
          <Skeleton variant="block" height="h-28" />
          <Skeleton variant="block" height="h-28" />
        </SkeletonGroup>
      ) : sample.length === 0 ? (
        <p className="mt-6 rounded-card border border-line bg-surface-panel px-4 py-3 text-body text-ink-mid">
          {t(loadError ? "onboardingV2.review.loadError" : "onboardingV2.review.empty")}
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {sample.map((item) => {
            const movedTo = moved.get(item.sourceId);
            const undoable = laneMove.notice?.emailId === item.sourceId;
            return (
              <ReviewRow
                key={item.id}
                item={item}
                lane={movedTo ?? labelFor(item)?.tier ?? item.tier}
                label={labelFor(item)}
                movedReversibly={movedTo !== undefined && movedTo !== toLiveTier(item.tier)}
                busy={isPending(item)}
                onConfirm={() => void label(item, "confirm")}
                onMove={(lane) => move(item, lane)}
                onUndo={undoable ? () => void laneMove.undo() : undefined}
                undoBusy={laneMove.busy}
              />
            );
          })}
        </ul>
      )}

      <p className="mt-4 text-caption text-ink-muted">{t("onboardingV2.review.note")}</p>

      <div className="mt-8 flex justify-end">
        <Button size="lg" className="max-sm:w-full" onClick={onContinue}>
          {t("onboardingV2.continue")}
        </Button>
      </div>
    </section>
  );
}

interface ReviewRowProps {
  item: FirewallItem;
  /** The lane shown now (after any move). */
  lane: string;
  /** Set once the user confirmed or (without the reversible override) moved it. */
  label: Label | undefined;
  movedReversibly: boolean;
  busy: boolean;
  onConfirm: () => void;
  onMove: (lane: LiveTier) => void;
  /** Present while the last move on this mail can still be undone. */
  onUndo: (() => void) | undefined;
  undoBusy: boolean;
}

function ReviewRow(props: ReviewRowProps) {
  const { item, lane, label, movedReversibly, busy, onConfirm, onMove, onUndo, undoBusy } = props;
  const { t } = useT();
  const shown = toLiveTier(lane);
  const sender = item.email?.from ?? t("onboardingV2.review.unknownSender");
  const subject = item.email?.subject ?? item.title ?? t("onboardingV2.review.noSubject");
  const moved = label?.kind === "corrected" || movedReversibly;
  return (
    <li className="rounded-card border border-line bg-surface-panel p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption text-ink-muted">{sender}</p>
          <p className="truncate text-head text-ink">{subject}</p>
        </div>
        <LaneChip tier={shown} className="mt-0.5" />
      </div>

      {label || moved ? (
        <div className="mt-2 flex min-h-11 flex-wrap items-center gap-x-3">
          <p role="status" className="text-label font-normal text-ink-soft">
            {t(moved ? "onboardingV2.review.movedTo" : "onboardingV2.review.keptIn", {
              lane: shown,
            })}
          </p>
          {onUndo && (
            <Button variant="ghost" size="sm" loading={undoBusy} onClick={onUndo}>
              {t("onboardingV2.review.undo")}
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onConfirm}>
            {t("onboardingV2.review.looksRight")}
          </Button>
          <span className="px-2 text-caption text-ink-muted">
            {t("onboardingV2.review.moveTo")}
          </span>
          {/* Lane names are product vocabulary and are not translated. */}
          {CORE_TIERS.filter((target) => target !== shown).map((target) => (
            <Button
              key={target}
              variant="ghost"
              size="sm"
              className="px-1.5"
              disabled={busy}
              aria-label={t("onboardingV2.review.moveToLane", { lane: target })}
              onClick={() => onMove(target)}
            >
              <LaneChip tier={target} />
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
