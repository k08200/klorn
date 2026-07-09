"use client";

import { useEffect, useState } from "react";
import {
  type FirewallItem,
  type FirewallResponse,
  TIER_VISUAL,
  type Tier,
} from "../../components/firewall-board";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

// Tiers the user can reassign to during onboarding. AUTO is an execution tier,
// not a manual triage target — mirrors the firewall board's override targets so
// onboarding and the everyday board teach the same vocabulary.
const MOVE_TARGETS: Tier[] = ["PUSH", "QUEUE", "SILENT"];
// Loudest tier first, quieted mail last, so the user reviews interrupts before
// the pile Klorn silenced.
const GROUP_ORDER: Tier[] = ["PUSH", "QUEUE", "AUTO", "SILENT"];

// Classification is fire-and-forget, so the freshly-synced emails trickle in as
// each judge call returns. Poll a bounded number of times until the count holds.
const MAX_POLLS = 8;
const POLL_MS = 2000;

type Label = { kind: "confirmed" | "corrected"; tier: Tier };

/**
 * Onboarding step 3: show the user how Klorn classified their most-recent inbox
 * and let them confirm or correct a few. Every confirm/correct writes a
 * DecisionLabel ground-truth row (CONFIRM:<tier> / OVERRIDE:<tier>) — the seed
 * that turns bounded accuracy into a point estimate and calibrates their tiers
 * from day one. Nothing is required: the user can continue at any time.
 */
export function ReviewStep({ onContinue }: { onContinue: () => void }) {
  const [items, setItems] = useState<FirewallItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [labels, setLabels] = useState<Record<string, Label>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    let lastLen = -1;
    let stableStreak = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const resp = await apiFetch<FirewallResponse>("/api/inbox/firewall/");
        if (cancelled) return;
        const emails = (Object.values(resp.tiers) as FirewallItem[][])
          .flat()
          .filter((it) => it.source === "EMAIL");
        setItems(emails);
        setLoading(false);
        stableStreak = emails.length === lastLen ? stableStreak + 1 : 0;
        lastLen = emails.length;
      } catch (err) {
        if (cancelled) return;
        captureClientError(err);
        setLoading(false);
        setLoadError(true);
        return; // stop polling on error
      }
      polls += 1;
      const settled = lastLen > 0 && stableStreak >= 1;
      if (!cancelled && polls < MAX_POLLS && !settled) {
        timer = setTimeout(tick, POLL_MS);
      }
    };
    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const label = async (item: FirewallItem, action: "confirm" | Tier) => {
    if (pending[item.id] || labels[item.id]) return;
    setPending((p) => ({ ...p, [item.id]: true }));
    try {
      if (action === "confirm") {
        await apiFetch(`/api/inbox/firewall/${item.id}/confirm`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setLabels((l) => ({ ...l, [item.id]: { kind: "confirmed", tier: item.tier } }));
      } else {
        await apiFetch(`/api/inbox/firewall/${item.id}`, {
          method: "POST",
          body: JSON.stringify({ tier: action }),
        });
        setLabels((l) => ({ ...l, [item.id]: { kind: "corrected", tier: action } }));
      }
    } catch (err) {
      captureClientError(err);
    } finally {
      setPending((p) => ({ ...p, [item.id]: false }));
    }
  };

  const reviewedCount = Object.keys(labels).length;
  // Group by ORIGINAL classification so a corrected card stays put (showing what
  // the user changed it to) rather than jumping between groups mid-review.
  const groups = GROUP_ORDER.map((tier) => ({
    tier,
    items: items.filter((it) => it.tier === tier),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-stone-50">
        Does this look right?
      </h1>
      <p className="mt-4 text-sm leading-6 text-stone-400">
        Klorn sorted your recent inbox into tiers. Confirm the calls it got right and fix the ones
        it didn&apos;t — a few is enough to teach it what matters to you.
      </p>

      {loading && items.length === 0 ? (
        <div className="mt-8 flex items-center gap-3 rounded-xl border border-stone-800 bg-stone-900/30 px-4 py-3">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-stone-600 border-t-amber-300 motion-reduce:animate-none" />
          <p className="text-sm text-stone-300">Reading your inbox…</p>
        </div>
      ) : null}

      {loadError && items.length === 0 ? (
        <p className="mt-8 rounded-xl border border-stone-800 bg-stone-900/30 px-4 py-3 text-sm text-stone-400">
          Couldn&apos;t load your classifications right now. You can review them anytime from your
          inbox.
        </p>
      ) : null}

      {!loading && !loadError && items.length === 0 ? (
        <p className="mt-8 rounded-xl border border-stone-800 bg-stone-900/30 px-4 py-3 text-sm text-stone-400">
          No mail to review yet — Klorn will sort new email as it arrives.
        </p>
      ) : null}

      <div className="mt-8 space-y-6">
        {groups.map((group) => (
          <section key={group.tier} aria-label={`${TIER_VISUAL[group.tier].label} emails`}>
            <div className="mb-2 flex items-baseline gap-2">
              <span className={`text-xs font-semibold ${TIER_VISUAL[group.tier].accent}`}>
                {TIER_VISUAL[group.tier].label}
              </span>
              <span className="text-[11px] text-stone-500">
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
        className="mt-8 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-5 py-3.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
      >
        {reviewedCount > 0 ? `Continue — ${reviewedCount} reviewed` : "Looks good — continue"}
        <span aria-hidden>→</span>
      </button>
      <p className="mt-3 text-center text-[11px] leading-5 text-stone-500">
        Every confirm or fix teaches Klorn. You can refine any tier later from your inbox.
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
  const sender = item.email?.from ?? "Unknown sender";
  const subject = item.email?.subject ?? item.title ?? "(no subject)";
  const snippet = item.email?.snippet ?? null;

  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/40 p-3">
      <p className="truncate text-xs text-stone-400">{sender}</p>
      <p className="mt-0.5 truncate text-sm font-medium text-stone-200">{subject}</p>
      {snippet ? <p className="mt-1 line-clamp-2 text-xs text-stone-500">{snippet}</p> : null}

      {labelState ? (
        <p className={`mt-3 text-xs font-semibold ${TIER_VISUAL[labelState.tier].accent}`}>
          {labelState.kind === "confirmed"
            ? `Kept in ${labelState.tier} ✓`
            : `Moved to ${labelState.tier} ✓`}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="min-h-11 rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:border-emerald-400/60 hover:bg-emerald-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Looks right
          </button>
          <span className="text-[11px] text-stone-600">or move to</span>
          {MOVE_TARGETS.filter((t) => t !== item.tier).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onCorrect(t)}
              disabled={busy}
              className={`min-h-11 rounded-lg border border-stone-700 px-3 py-1.5 text-xs font-medium text-stone-400 transition hover:bg-stone-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500 disabled:cursor-not-allowed disabled:opacity-50 ${TIER_VISUAL[t].accent}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
