"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { CardSkeleton } from "../../components/skeleton";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { isNativePlatform } from "../../lib/native/capacitor";

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
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** Round to cents; sub-cent spend reads "< $0.01" instead of a noisy $0.0001. */
function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "< $0.01";
  return `$${amount.toFixed(2)}`;
}

const PLANS = [
  {
    key: "FREE",
    name: "Free",
    price: "$0",
    period: "",
    limit: "50 decisions/mo · 500K tokens",
    features: ["Mail and calendar reading", "Tasks and memory", "Free OpenRouter models"],
  },
  {
    key: "PRO",
    name: "Pro",
    // Founding price — must match paywall-screen.tsx / subscription-section.tsx
    // (web $7.99; native shows $9.99 there) and the live Stripe Price object.
    price: "$7.99",
    period: "/mo",
    limit: "2K decisions/mo · 10M tokens",
    features: [
      "Everything in Free",
      "Send mail and create calendar events",
      "Decision loop mode: suggest + policy execution",
      "Daily briefings and mail triage",
      "Reply drafts and pattern learning",
      "Slack and Notion integrations (coming soon)",
      "Web research and document drafts",
      "Claude Sonnet model selection",
    ],
  },
  {
    key: "ENTERPRISE",
    name: "Enterprise",
    price: "Custom",
    period: "",
    limit: "Unlimited",
    features: [
      "Everything in Pro",
      "Claude Opus selection",
      "On-prem options",
      "SLA support",
      "Custom integrations",
    ],
  },
];

export default function BillingPage() {
  return (
    <AuthGuard>
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

  const success = searchParams.get("success");
  const canceled = searchParams.get("canceled");

  useEffect(() => {
    apiFetch<BillingStatus>("/api/billing/status")
      .then(setStatus)
      .catch(() => toast("Could not load billing status.", "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  /** Only allow our payment providers' hosted URLs to prevent open redirect */
  function safeRedirect(url: string) {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === "https:" &&
        (parsed.hostname.endsWith(".stripe.com") ||
          parsed.hostname.endsWith(".paddle.com") ||
          parsed.hostname === "paddle.com")
      ) {
        window.location.href = url;
      } else {
        toast("Unsafe billing redirect URL.", "error");
      }
    } catch {
      toast("Could not verify billing redirect URL.", "error");
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
      toast("Could not create checkout session.", "error");
    }
  }

  async function handleManage() {
    try {
      const { url } = await apiFetch<{ url: string }>("/api/billing/portal", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (url) safeRedirect(url);
    } catch {
      toast("Could not open billing portal.", "error");
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-28 pt-6 sm:px-6 md:py-10">
      <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
          Plan ledger
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50 md:text-3xl">
          Klorn limits and execution access
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
          Review decision limits, model usage, execution modes, and the plan that fits your team.
        </p>
      </header>

      {success && (
        <div className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          Subscription is active.
        </div>
      )}
      {canceled && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          Checkout was canceled.
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
        <div className="mb-8 rounded-2xl border border-stone-700/45 bg-stone-950/40 p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-500">
                Current plan
              </p>
              <p className="mt-1 text-xl font-semibold text-stone-50">{status.planName}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {status.estimatedCost > 0 && (
                <span className="rounded-full border border-stone-700 bg-stone-900/70 px-3 py-1 text-xs text-stone-400">
                  About {formatUsd(status.estimatedCost)} this month
                </span>
              )}
              {/* No Stripe checkout/portal inside the iOS app (App Store
                  anti-steering 3.1.1). Billing is managed on the web; the app
                  offers IAP at launch. */}
              {(status.stripeId || status.hasPaddleCustomer) && !isNativePlatform() && (
                <button
                  type="button"
                  onClick={handleManage}
                  className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-400/15"
                >
                  Manage subscription
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Decision turns usage */}
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span className="text-stone-400">Decisions</span>
                <span className="text-stone-300">
                  {status.messageCount} /{" "}
                  {isFiniteLimit(status.messageLimit) ? status.messageLimit.toLocaleString() : "∞"}
                </span>
              </div>
              {isFiniteLimit(status.messageLimit) && status.messageLimit > 0 && (
                <div className="h-2 w-full rounded-full bg-stone-800">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      status.messageCount / status.messageLimit > 0.9
                        ? "bg-red-500"
                        : status.messageCount / status.messageLimit > 0.7
                          ? "bg-amber-400"
                          : "bg-emerald-400"
                    }`}
                    style={{
                      width: `${Math.min((status.messageCount / status.messageLimit) * 100, 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>

            {/* Tokens usage */}
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span className="text-stone-400">Tokens</span>
                <span className="text-stone-300">
                  {formatTokens(status.tokenUsage)} /{" "}
                  {isFiniteLimit(status.tokenLimit) ? formatTokens(status.tokenLimit) : "∞"}
                </span>
              </div>
              {isFiniteLimit(status.tokenLimit) && status.tokenLimit > 0 && (
                <div className="h-2 w-full rounded-full bg-stone-800">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      status.tokenUsage / status.tokenLimit > 0.9
                        ? "bg-red-500"
                        : status.tokenUsage / status.tokenLimit > 0.7
                          ? "bg-amber-400"
                          : "bg-teal-400"
                    }`}
                    style={{
                      width: `${Math.min((status.tokenUsage / status.tokenLimit) * 100, 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {PLANS.map((plan) => {
          const isCurrent = status?.plan === plan.key;
          return (
            <div
              key={plan.key}
              className={`flex flex-col rounded-2xl border bg-stone-950/35 p-6 ${
                isCurrent
                  ? "border-amber-300/70"
                  : plan.key === "PRO"
                    ? "border-amber-400/45 ring-1 ring-amber-400/15"
                    : "border-stone-700/45"
              }`}
            >
              {plan.key === "PRO" && (
                <span className="mb-2 self-start rounded-full bg-amber-300 px-2 py-0.5 text-[10px] font-semibold uppercase text-stone-950">
                  Recommended
                </span>
              )}
              <p className="mb-1 text-lg font-semibold text-stone-50">{plan.name}</p>
              <p className="mb-1 text-2xl font-semibold text-stone-50">
                {plan.price}
                <span className="text-sm font-normal text-stone-500">{plan.period}</span>
              </p>
              <p className="mb-4 text-sm text-stone-400">{plan.limit}</p>

              <ul className="mb-6 flex-1 space-y-2">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-stone-300">
                    <span aria-hidden="true" className="mt-0.5 text-emerald-300">
                      ✓
                    </span>
                    {f}
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 py-2 text-center text-sm font-medium text-amber-100">
                  Current plan
                </div>
              ) : plan.key === "FREE" ? (
                // Non-current FREE card: render a neutral pill (not an empty div)
                // so every plan card keeps the same footer height and alignment.
                <div className="rounded-lg border border-stone-700 bg-stone-900/40 py-2 text-center text-sm font-medium text-stone-400">
                  Included with every plan
                </div>
              ) : plan.key === "ENTERPRISE" ? (
                <a
                  href="mailto:sales@klorn.ai"
                  className="block rounded-lg border border-stone-700 bg-stone-900/70 py-2.5 text-center text-sm font-medium text-stone-100 transition hover:border-stone-500"
                >
                  Contact sales
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
                  className="rounded-lg bg-amber-300/60 py-2.5 text-sm font-semibold text-stone-950"
                >
                  Subscription coming soon
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleUpgrade(plan.key as "PRO")}
                  className="rounded-lg bg-amber-300 py-2.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
                >
                  Upgrade to {plan.name}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
