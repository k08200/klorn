"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { PaddleLoader } from "../../components/paddle-loader";
import { PAGE_SHELL } from "../../components/page-shell";
import { CardSkeleton } from "../../components/skeleton";
import { SubscriptionManager, SubscriptionStatusLine } from "../../components/subscription-manager";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { isSafeBillingRedirect } from "../../lib/billing-redirect";
import { checkoutReturnUrl } from "../../lib/checkout-return";
import { useT } from "../../lib/i18n";
import { isNativePlatform } from "../../lib/native/capacitor";
import { PRO_PRICE_WEB } from "../../lib/pricing";
import { toSubscriptionState } from "../../lib/subscription";

/** Server-side Infinity arrives as null through JSON — treat both as "unlimited". */
function isFiniteLimit(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

interface BillingStatus {
  plan: string;
  planName: string;
  /** null = unlimited (Infinity does not survive JSON serialization). */
  messageLimit: number | null;
  messageCount: number;
  tokenLimit: number | null;
  tokenUsage: number;
  estimatedCost: number;
  stripeId: string | null;
  /** True when the account has a Paddle customer record (manageable via portal). */
  hasPaddleCustomer?: boolean;
  // Whether the web (Stripe) checkout can complete server-side. When false
  // the upgrade button shows a disabled state instead of firing a checkout
  // that 400s. Undefined (older API) = assume available.
  webCheckoutAvailable?: boolean;
  /** Provider status: active | trialing | past_due | paused | canceled. */
  subscriptionStatus?: string | null;
  /** ISO date of the next automatic charge; null while a cancel is scheduled. */
  renewsAt?: string | null;
  /** ISO date access ends when a cancellation is scheduled. */
  cancelAt?: string | null;
  /** True when the in-app cancel route can act (Paddle subscription on file). */
  canCancelInApp?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** A plan is metered when at least one of its two limits is a real number. */
function isMetered(status: BillingStatus): boolean {
  return isFiniteLimit(status.messageLimit) || isFiniteLimit(status.tokenLimit);
}

/**
 * One usage row: label, used/limit, and a bar. The two metrics used to be the
 * same thirty lines written twice.
 */
function UsageMeter({
  label,
  used,
  limit,
  format,
}: {
  label: string;
  used: number;
  limit: number | null;
  format: (n: number) => string;
}) {
  const metered = isFiniteLimit(limit) && limit > 0;
  const ratio = metered ? used / limit : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-ink-mid">{label}</span>
        <span className="text-ink-mid tabular-nums">
          {format(used)} / {isFiniteLimit(limit) ? format(limit) : "\u221e"}
        </span>
      </div>
      {metered && (
        <div className="h-2 w-full rounded-full bg-surface-hover">
          <div
            className={`h-2 rounded-full transition-[width] duration-500 ${
              ratio > 0.9 ? "bg-red-500" : ratio > 0.7 ? "bg-amber-400" : "bg-emerald-400"
            }`}
            style={{ width: `${Math.min(ratio * 100, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** Round to cents; sub-cent spend reads "< $0.01" instead of a noisy $0.0001. */
function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "< $0.01";
  return `$${amount.toFixed(2)}`;
}

interface PlanDef {
  key: "FREE" | "PRO" | "ENTERPRISE";
  nameKey: string;
  /** Literal price string (e.g. "$0", PRO_PRICE_WEB) — null when priceKey is a translated label instead ("Custom"). */
  price: string | null;
  priceKey: string | null;
  periodKey: string | null;
  limitKey: string;
  trialNoteKey: string | null;
  featureKeys: string[];
}

// Translation keys only — actual strings resolve at render time via t(),
// since this is a module-level constant outside the component (hooks rule).
const PLANS: PlanDef[] = [
  {
    key: "FREE",
    nameKey: "billing.plan.free.name",
    price: "$0",
    priceKey: null,
    periodKey: null,
    limitKey: "billing.plan.free.limit",
    trialNoteKey: null,
    featureKeys: [
      "billing.plan.free.feature.mailCalendar",
      "billing.plan.free.feature.tasksMemory",
      "billing.plan.free.feature.freeModels",
    ],
  },
  {
    key: "PRO",
    nameKey: "billing.plan.pro.name",
    // Single source of truth — see lib/pricing.ts. This card is web-only.
    price: PRO_PRICE_WEB,
    priceKey: null,
    periodKey: "billing.plan.pro.period",
    // Trial length is configured on the Paddle price (founder decision,
    // 2026-08-13) — keep this line in sync with the Paddle dashboard.
    trialNoteKey: "billing.plan.pro.trialNote",
    limitKey: "billing.plan.pro.limit",
    featureKeys: [
      "billing.plan.pro.feature.everythingFree",
      "billing.plan.pro.feature.sendMail",
      "billing.plan.pro.feature.decisionLoop",
      "billing.plan.pro.feature.briefings",
      "billing.plan.pro.feature.replyDrafts",
      "billing.plan.pro.feature.integrations",
      "billing.plan.pro.feature.webResearch",
      "billing.plan.pro.feature.sonnet",
    ],
  },
  {
    key: "ENTERPRISE",
    nameKey: "billing.plan.enterprise.name",
    price: null,
    priceKey: "billing.plan.enterprise.price",
    periodKey: null,
    limitKey: "billing.plan.enterprise.limit",
    trialNoteKey: null,
    featureKeys: [
      "billing.plan.enterprise.feature.everythingPro",
      "billing.plan.enterprise.feature.opus",
      "billing.plan.enterprise.feature.onPrem",
      "billing.plan.enterprise.feature.sla",
      "billing.plan.enterprise.feature.customIntegrations",
    ],
  },
];

export default function BillingPage() {
  return (
    <AuthGuard>
      {/* Paddle.js must live on this page: it detects the _ptxn param on the
          default-payment-link URL and opens the checkout overlay. A completed
          checkout navigates to the same page WITHOUT that param, which both
          refetches the webhook-granted plan and stops Paddle.js from reopening
          the finished transaction. replace(), not assign(), so Back can't land
          the customer on the _ptxn url again. */}
      <PaddleLoader
        onCheckoutCompleted={() => {
          window.location.replace(checkoutReturnUrl(window.location.href));
        }}
      />
      <Suspense>
        <BillingContent />
      </Suspense>
    </AuthGuard>
  );
}

function BillingContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const { t } = useT();

  const success = searchParams.get("success");
  const canceled = searchParams.get("canceled");

  const loadStatus = useCallback(
    () =>
      apiFetch<BillingStatus>("/api/billing/status")
        .then(setStatus)
        .catch(() => toast(t("billing.error.loadStatus"), "error"))
        .finally(() => setLoading(false)),
    [toast, t],
  );

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /** Refuse any redirect target that is not us or a payment provider. */
  function safeRedirect(url: string) {
    if (isSafeBillingRedirect(url, window.location.origin)) {
      window.location.href = url;
    } else {
      toast(t("billing.error.unsafeRedirect"), "error");
    }
  }

  async function handleUpgrade(plan: "PRO") {
    try {
      const { url } = await apiFetch<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan }),
      });
      if (url) safeRedirect(url);
    } catch {
      toast(t("billing.error.checkoutFailed"), "error");
    }
  }

  return (
    <div className={PAGE_SHELL}>
      <header className="mb-8">
        <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
          {t("billing.title")}
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-ink-mid">{t("billing.subtitle")}</p>
      </header>

      {success && (
        <div className="mb-6 rounded-xl border border-state-ok-line bg-state-ok-bg p-4 text-sm text-state-ok-ink">
          {t("billing.subscriptionActive")}
        </div>
      )}
      {canceled && (
        <div className="mb-6 rounded-xl border border-state-warn-line bg-state-warn-bg p-4 text-sm text-state-warn-ink">
          {t("billing.checkoutCanceled")}
        </div>
      )}

      {loading && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {["s1", "s2", "s3"].map((sk) => (
            <CardSkeleton key={sk} />
          ))}
        </div>
      )}

      {!loading && status && (
        <div className="panel-elevated mb-8 rounded-2xl border border-line/70 bg-surface-panel p-5">
          {/* Identity on the left, actions on the right. The renewal line
              sits under the plan name because it is a fact ABOUT the plan,
              not a caption for the buttons — floated up next to them it read
              as an orphan. The month-to-date cost moved down to the usage
              grid, where the other spend numbers live. */}
          <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-mid">
                {t("billing.currentPlan")}
              </p>
              <p className="mt-1 text-xl font-semibold text-ink">{status.planName}</p>
              <SubscriptionStatusLine state={toSubscriptionState(status)} />
            </div>
            {/* Portal + in-app cancel. Renders nothing inside the native app
                (App Store anti-steering 3.1.1) and nothing for an account
                with no billing record — the gate lives in the component. */}
            <SubscriptionManager state={toSubscriptionState(status)} onChanged={loadStatus} />
          </div>

          {isMetered(status) ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <UsageMeter
                label={t("billing.decisions")}
                used={status.messageCount}
                limit={status.messageLimit}
                format={(n) => n.toLocaleString()}
              />
              <UsageMeter
                label={t("billing.tokens")}
                used={status.tokenUsage}
                limit={status.tokenLimit}
                format={formatTokens}
              />
            </div>
          ) : (
            // Unlimited plan: no bar to draw, and the metered layout flung
            // each label to the opposite end of a half-width grid cell, then
            // stacked cost and the usage link under it — five rows of mostly
            // air. Everything that is left collapses into one dense line.
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm text-ink-mid">
              <span>
                {t("billing.decisions")}{" "}
                <span className="font-medium text-ink tabular-nums">
                  {status.messageCount.toLocaleString()}
                </span>
              </span>
              <span>
                {t("billing.tokens")}{" "}
                <span className="font-medium text-ink tabular-nums">
                  {formatTokens(status.tokenUsage)}
                </span>
              </span>
              <span>{t("billing.unlimitedOnPlan")}</span>
              {status.estimatedCost > 0 && (
                <span className="tabular-nums">
                  {t("billing.aboutCostThisMonth", { amount: formatUsd(status.estimatedCost) })}
                </span>
              )}
              <Link
                href="/usage"
                className="focus-ring rounded font-medium text-accent-deeper hover:underline"
              >
                {t("billing.viewDetailedUsage")}
              </Link>
            </div>
          )}

          {isMetered(status) && (
            <>
              {status.estimatedCost > 0 && (
                <p className="mt-2 text-xs text-ink-mid tabular-nums">
                  {t("billing.aboutCostThisMonth", { amount: formatUsd(status.estimatedCost) })}
                </p>
              )}
              <Link
                href="/usage"
                className="focus-ring mt-3 inline-flex min-h-11 items-center rounded text-sm font-medium text-accent-deeper hover:underline"
              >
                {t("billing.viewDetailedUsage")}
              </Link>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {PLANS.map((plan) => {
          const isCurrent = status?.plan === plan.key;
          return (
            <div
              key={plan.key}
              className={`panel-elevated flex flex-col rounded-2xl border bg-surface-panel p-6 ${
                isCurrent
                  ? "border-accent-muted/70"
                  : plan.key === "PRO"
                    ? "border-accent-light/45 ring-1 ring-accent-light/15"
                    : "border-line/70"
              }`}
            >
              {plan.key === "PRO" && (
                <span className="mb-2 self-start rounded-full bg-accent-solid px-2 py-0.5 text-caption font-semibold uppercase text-accent-solid-ink">
                  {t("billing.recommended")}
                </span>
              )}
              <p className="mb-1 text-lg font-semibold text-ink">{t(plan.nameKey)}</p>
              <p className="mb-1 text-2xl font-semibold text-ink tabular-nums">
                {plan.priceKey ? t(plan.priceKey) : plan.price}
                <span className="text-sm font-normal text-ink-mid">
                  {plan.periodKey ? t(plan.periodKey) : ""}
                </span>
              </p>
              <p className="mb-1 text-sm text-ink-mid">{t(plan.limitKey)}</p>
              {plan.trialNoteKey ? (
                <p className="mb-4 text-xs font-medium text-state-ok-ink">{t(plan.trialNoteKey)}</p>
              ) : (
                <div className="mb-4" />
              )}

              <ul className="mb-6 flex-1 space-y-2">
                {plan.featureKeys.map((fKey) => (
                  <li key={fKey} className="flex items-start gap-2 text-sm text-ink-mid">
                    <span aria-hidden="true" className="mt-0.5 text-state-ok-ink">
                      ✓
                    </span>
                    {t(fKey)}
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <div className="rounded-lg border border-accent-muted/45 bg-accent/8 py-2 text-center text-sm font-medium text-accent-deeper">
                  {t("billing.currentPlan")}
                </div>
              ) : plan.key === "FREE" ? (
                // Non-current FREE card: render a neutral pill (not an empty div)
                // so every plan card keeps the same footer height and alignment.
                <div className="rounded-lg border border-line bg-surface-raised py-2 text-center text-sm font-medium text-ink-mid">
                  {t("billing.includedWithEveryPlan")}
                </div>
              ) : plan.key === "ENTERPRISE" ? (
                <a
                  href="mailto:k0820086@gmail.com"
                  className="ease-strong block rounded-lg border border-line bg-surface-panel/70 py-2.5 text-center text-sm font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] focus-ring min-h-11"
                >
                  {t("billing.contactSales")}
                </a>
              ) : isNativePlatform() ? (
                // iOS app: no Stripe checkout (anti-steering). The IAP purchase
                // button takes this slot at launch.
                <div aria-hidden="true" />
              ) : status?.webCheckoutAvailable === false ? (
                // Stripe not configured server-side (native-IAP-only launch) —
                // a live button here would fire a checkout that 400s.
                <button
                  type="button"
                  disabled
                  className="rounded-lg border border-line bg-surface-hover py-2.5 text-sm font-semibold text-ink-dim min-h-11"
                >
                  {t("billing.subscriptionComingSoon")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleUpgrade(plan.key as "PRO")}
                  className="glow-primary ease-strong focus-ring min-h-11 rounded-lg bg-accent-solid py-2.5 text-sm font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97]"
                >
                  {t("billing.startTrial")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <PlanDetails />
    </div>
  );
}

/**
 * Factual plan/trial explanations under the cards. Copy rules: measured
 * claims only, numbers must match the Paddle price configuration and the
 * PLANS array above — no marketing language. Keys resolve via t() in
 * PlanDetails; the trial answer interpolates PRO_PRICE_WEB as {price}.
 */
const PLAN_FAQ = [
  { qKey: "billing.faq.trial.q", aKey: "billing.faq.trial.a" },
  { qKey: "billing.faq.freeVsPro.q", aKey: "billing.faq.freeVsPro.a" },
  { qKey: "billing.faq.enterprise.q", aKey: "billing.faq.enterprise.a" },
  { qKey: "billing.faq.manage.q", aKey: "billing.faq.manage.a" },
  { qKey: "billing.faq.paymentMethods.q", aKey: "billing.faq.paymentMethods.a" },
];

function PlanDetails() {
  const { t } = useT();
  return (
    <section className="mt-10" aria-labelledby="plan-details-heading">
      <h2 id="plan-details-heading" className="mb-4 text-lg font-semibold text-ink">
        {t("billing.planDetailsHeading")}
      </h2>
      <dl className="space-y-4">
        {PLAN_FAQ.map((item) => (
          <div
            key={item.qKey}
            className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5"
          >
            <dt className="text-sm font-semibold text-ink">{t(item.qKey)}</dt>
            <dd className="mt-1.5 text-sm leading-relaxed text-ink-mid">
              {t(item.aKey, { price: PRO_PRICE_WEB })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
