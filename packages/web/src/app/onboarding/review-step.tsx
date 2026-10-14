"use client";

import { type FirewallItem, TIER_VISUAL, type Tier } from "../../components/firewall-board";
import { useT } from "../../lib/i18n";
import { CORE_TIERS } from "../../lib/tiers";
import { type Label, useFirewallEmails, useFirewallLabels } from "./use-firewall-emails";

// Both lists are the five live lanes, loudest first: the user reviews
// interrupts before the pile Klorn silenced, and can reassign to any lane the
// classifier itself can emit. They used to be hand-written subsets that
// omitted MEETING and INFO, so mail in those two lanes was filtered out of the
// review below and never shown — which also meant onboarding never collected a
// single DecisionLabel for them, the ground truth the accuracy figure rests on.
const MOVE_TARGETS = CORE_TIERS;
const GROUP_ORDER = CORE_TIERS;

/**
 * Onboarding step 3: show the user how Klorn classified their most-recent inbox
 * and let them confirm or correct a few. Every confirm/correct writes a
 * DecisionLabel ground-truth row (CONFIRM:<tier> / OVERRIDE:<tier>) — the seed
 * that turns bounded accuracy into a point estimate and calibrates their tiers
 * from day one. Nothing is required: the user can continue at any time.
 */
export function ReviewStep({ onContinue }: { onContinue: () => void }) {
  const { t } = useT();
  const { items, loading, loadError } = useFirewallEmails();
  const { labels, pending, label } = useFirewallLabels();

  const reviewedCount = Object.keys(labels).length;
  // Group by ORIGINAL classification so a corrected card stays put (showing what
  // the user changed it to) rather than jumping between groups mid-review.
  const groups = GROUP_ORDER.map((tier) => ({
    tier,
    items: items.filter((it) => it.tier === tier),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink">
        {t("onboarding.review.title")}
      </h1>
      <p className="mt-4 text-sm leading-6 text-ink-mid">{t("onboarding.review.desc")}</p>

      {loading && items.length === 0 ? (
        <div className="mt-8 flex items-center gap-3 rounded-xl border border-line bg-surface-raised px-4 py-3">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent motion-reduce:animate-none" />
          <p className="text-sm text-ink-mid">{t("onboarding.review.readingInbox")}</p>
        </div>
      ) : null}

      {loadError && items.length === 0 ? (
        <p className="mt-8 rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm text-ink-mid">
          {t("onboarding.review.loadError")}
        </p>
      ) : null}

      {!loading && !loadError && items.length === 0 ? (
        <p className="mt-8 rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm text-ink-mid">
          {t("onboarding.review.emptyState")}
        </p>
      ) : null}

      <div className="mt-8 space-y-6">
        {groups.map((group) => (
          <section
            key={group.tier}
            aria-label={t("onboarding.review.groupAriaLabel", {
              tier: TIER_VISUAL[group.tier].label,
            })}
          >
            <div className="mb-2 flex items-baseline gap-2">
              <span className={`text-xs font-semibold ${TIER_VISUAL[group.tier].accent}`}>
                {TIER_VISUAL[group.tier].label}
              </span>
              <span className="text-[11px] text-ink-dim">
                {TIER_VISUAL[group.tier].description}
              </span>
            </div>
            <div className="space-y-2">
              {group.items.map((item) => (
                <ReviewCard
                  key={item.id}
                  item={item}
                  labelState={labels[item.id]}
                  busy={!!pending[item.id]}
                  onConfirm={() => label(item, "confirm")}
                  onCorrect={(tier) => label(item, tier)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="mt-8 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent-solid px-5 py-3.5 text-sm font-semibold text-accent-solid-ink transition hover:bg-accent-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
      >
        {reviewedCount > 0
          ? t("onboarding.review.continueReviewed", { count: String(reviewedCount) })
          : t("onboarding.review.continueDefault")}
        <span aria-hidden>→</span>
      </button>
      <p className="mt-3 text-center text-[11px] leading-5 text-ink-dim">
        {t("onboarding.review.footerNote")}
      </p>
    </div>
  );
}

function ReviewCard({
  item,
  labelState,
  busy,
  onConfirm,
  onCorrect,
}: {
  item: FirewallItem;
  labelState: Label | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCorrect: (tier: Tier) => void;
}) {
  const { t } = useT();
  const sender = item.email?.from ?? t("onboarding.review.card.unknownSender");
  const subject = item.email?.subject ?? item.title ?? t("onboarding.review.card.noSubject");
  const snippet = item.email?.snippet ?? null;

  return (
    <div className="rounded-xl border border-line bg-surface-panel p-3">
      <p className="truncate text-xs text-ink-mid">{sender}</p>
      <p className="mt-0.5 truncate text-sm font-medium text-ink">{subject}</p>
      {snippet ? <p className="mt-1 line-clamp-2 text-xs text-ink-dim">{snippet}</p> : null}

      {labelState ? (
        <p className={`mt-3 text-xs font-semibold ${TIER_VISUAL[labelState.tier].accent}`}>
          {labelState.kind === "confirmed"
            ? t("onboarding.review.card.keptIn", { tier: labelState.tier })
            : t("onboarding.review.card.movedTo", { tier: labelState.tier })}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="min-h-11 rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:border-emerald-400/60 hover:bg-emerald-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("onboarding.review.card.looksRight")}
          </button>
          <span className="text-[11px] text-ink-dim">{t("onboarding.review.card.orMoveTo")}</span>
          {/* Tier codes (PUSH/QUEUE/SILENT) are product vocabulary, not
              translated — see docs/product-vocabulary.md. */}
          {MOVE_TARGETS.filter((target) => target !== item.tier).map((target) => (
            <button
              key={target}
              type="button"
              onClick={() => onCorrect(target)}
              disabled={busy}
              className={`min-h-11 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-mid transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50 ${TIER_VISUAL[target].accent}`}
            >
              {target}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
