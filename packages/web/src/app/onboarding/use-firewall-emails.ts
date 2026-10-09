"use client";

import { useEffect, useState } from "react";
import type { FirewallItem, FirewallResponse, Tier } from "../../components/firewall-board";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

// Classification is fire-and-forget, so the freshly-synced emails trickle in as
// each judge call returns. Poll a bounded number of times until the count holds.
const MAX_POLLS = 8;
const POLL_MS = 2000;

export interface FirewallEmails {
  items: FirewallItem[];
  loading: boolean;
  loadError: boolean;
}

/**
 * The user's classified mail for the first-run review, shared by the review
 * step and the multi-provider first run's sorting check (ONBOARDING_V2).
 */
export function useFirewallEmails(): FirewallEmails {
  const [items, setItems] = useState<FirewallItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

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

  return { items, loading, loadError };
}

export type Label = { kind: "confirmed" | "corrected"; tier: Tier };

/**
 * Confirm or correct a classification, once per mail. Every confirm/correct
 * writes a DecisionLabel ground-truth row (CONFIRM:<tier> / OVERRIDE:<tier>).
 * A correction is a reclassification only: nothing reaches the mailbox.
 */
export function useFirewallLabels() {
  const [labels, setLabels] = useState<Record<string, Label>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});

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

  return { labels, pending, label };
}
