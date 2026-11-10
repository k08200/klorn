import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { Locale } from "./i18n";

/**
 * Subscription state as reported by GET /api/billing/status.
 *
 * The provider (Paddle) is the source of truth; the API mirrors the fields the
 * UI needs so a subscriber can see WHEN they renew, WHEN a cancellation takes
 * effect, and whether the in-app cancel route can act for them. Every field is
 * optional so an older API deploy degrades to "no detail" instead of crashing.
 */
export interface SubscriptionState {
  /** Provider status: active | trialing | past_due | paused | canceled. */
  subscriptionStatus?: string | null;
  /** ISO date of the next automatic charge. Null while a cancel is scheduled. */
  renewsAt?: string | null;
  /** ISO date access ends when a cancellation is scheduled. Null = no pending cancel. */
  cancelAt?: string | null;
  /** True when POST /api/billing/cancel can act (Paddle subscription on file). */
  canCancelInApp?: boolean;
  /** True when a provider portal exists for this account (Stripe or Paddle). */
  hasPortal?: boolean;
  /** The plan itself, so a paid account with nothing to manage can say why. */
  plan?: string;
}

/** Plans that cost money, and therefore owe the user an explanation when the
 *  page shows no subscription controls at all. */
const PAID_PLANS = new Set(["PRO", "TEAM", "ENTERPRISE"]);

export function isPaidPlan(plan: string | undefined): boolean {
  return Boolean(plan && PAID_PLANS.has(plan));
}

/** A cancellation is pending when the provider gave us an end date. */
export function hasPendingCancel(state: SubscriptionState): boolean {
  return Boolean(state.cancelAt);
}

/**
 * Localized medium date ("Sep 21, 2026" / "2026년 9월 21일"). Returns null for
 * a missing or unparseable value so callers fall back to the no-date copy
 * rather than rendering "Invalid Date".
 */
export function formatBillingDate(iso: string | null | undefined, locale: Locale): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The single status line shown above the subscription buttons, as a
 * translation key + optional {date} interpolation.
 *
 * A scheduled cancellation is checked FIRST, ahead of past_due/paused. Someone
 * who has already asked to leave should not be told to "update your payment
 * method to keep Pro" — that contradicts the "Keep subscription" button next
 * to it and pushes an action they did not ask for. A payment problem only
 * needs surfacing while the subscription is still meant to continue.
 */
export function subscriptionStatusLine(
  state: SubscriptionState,
  locale: Locale,
): { key: string; date?: string } | null {
  if (state.cancelAt) {
    const date = formatBillingDate(state.cancelAt, locale);
    return date ? { key: "billing.accessEndsOn", date } : { key: "billing.accessEndsSoon" };
  }

  if (state.subscriptionStatus === "past_due") return { key: "billing.statusPastDue" };
  if (state.subscriptionStatus === "paused") return { key: "billing.statusPaused" };

  const renews = formatBillingDate(state.renewsAt, locale);
  if (!renews) return null;
  return state.subscriptionStatus === "trialing"
    ? { key: "billing.trialFirstCharge", date: renews }
    : { key: "billing.renewsOn", date: renews };
}

/** The subset of GET /api/billing/status this module reads. */
interface BillingStatusPayload {
  plan?: string;
  stripeId?: string | null;
  hasPaddleCustomer?: boolean;
  subscriptionStatus?: string | null;
  renewsAt?: string | null;
  cancelAt?: string | null;
  canCancelInApp?: boolean;
}

/**
 * Narrow a /api/billing/status payload to the subscription slice. hasPortal
 * covers both providers: a Stripe customer or a Paddle one. Shared so the
 * billing page and Settings can never disagree about who gets which button.
 */
export function toSubscriptionState(status: BillingStatusPayload): SubscriptionState {
  return {
    subscriptionStatus: status.subscriptionStatus,
    renewsAt: status.renewsAt,
    cancelAt: status.cancelAt,
    canCancelInApp: status.canCancelInApp,
    hasPortal: Boolean(status.stripeId || status.hasPaddleCustomer),
    plan: status.plan,
  };
}

/**
 * Fetch subscription state for a surface that does not already load the full
 * billing status (Settings). `reload` is what the manager calls after a cancel
 * or an undo so the rendered dates match the provider again.
 *
 * A failed load is non-fatal by design: the surface keeps whatever it last
 * knew rather than blanking or blocking on a billing endpoint.
 */
export function useSubscriptionState(enabled: boolean): {
  state: SubscriptionState;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<SubscriptionState>({});

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setState(toSubscriptionState(await apiFetch<BillingStatusPayload>("/api/billing/status")));
    } catch {
      // Keep the last good state. Blanking it here would hide every
      // subscription control (the manager renders nothing without state) on a
      // transient failure — including the reload fired right after a cancel.
    }
  }, [enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
}
