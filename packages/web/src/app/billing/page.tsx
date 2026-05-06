"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { CardSkeleton } from "../../components/skeleton";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";

interface BillingStatus {
  plan: string;
  planName: string;
  messageLimit: number;
  messageCount: number;
  tokenLimit: number;
  tokenUsage: number;
  estimatedCost: number;
  stripeId: string | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const PLANS = [
  {
    key: "FREE",
    name: "Free",
    price: "$0",
    period: "",
    limit: "50 msgs · 500K tokens/mo",
    features: ["Email & Calendar read-only", "Task & note management", "Free OpenRouter model"],
  },
  {
    key: "PRO",
    name: "Pro",
    price: "$29",
    period: "/mo",
    limit: "2K msgs · 10M tokens/mo",
    features: [
      "Everything in Free",
      "Email send & Calendar create",
      "EVE autonomous agent (Suggest + Auto)",
      "Daily briefing & Email auto-classify",
      "Email auto-reply & Pattern learning",
      "Slack & Notion integrations",
      "Web search & Document writer",
      "Optional GPT-5.4 + Claude Sonnet models",
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
      "Optional Claude Opus model access",
      "On-premise option",
      "SLA guarantee",
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
      .catch(() => toast("Failed to load billing info", "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  /** Only allow Stripe-hosted URLs to prevent open redirect */
  function safeRedirect(url: string) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith(".stripe.com")) {
        window.location.href = url;
      } else {
        toast("Invalid redirect URL", "error");
      }
    } catch {
      toast("Invalid redirect URL", "error");
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
      toast("Failed to create checkout session", "error");
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
      toast("Failed to open billing portal", "error");
    }
  }

  return (
    <main className="max-w-5xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">Billing</h1>
      <p className="text-gray-400 mb-8">Choose a plan that fits your workflow</p>

      {success && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 mb-6">
          Subscription activated successfully!
        </div>
      )}
      {canceled && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4 mb-6">
          Checkout was canceled.
        </div>
      )}

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {["s1", "s2", "s3", "s4"].map((sk) => (
            <CardSkeleton key={sk} />
          ))}
        </div>
      )}

      {!loading && status && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-gray-500">Current Plan</p>
              <p className="text-xl font-bold">{status.planName}</p>
            </div>
            <div className="flex items-center gap-3">
              {status.estimatedCost > 0 && (
                <span className="text-xs text-gray-500">
                  ~${status.estimatedCost.toFixed(4)} this month
                </span>
              )}
              {status.stripeId && (
                <button
                  type="button"
                  onClick={handleManage}
                  className="bg-gray-800 hover:bg-gray-700 text-white px-4 py-2 rounded-lg text-sm transition"
                >
                  Manage Subscription
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Messages usage */}
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-400">Messages</span>
                <span className="text-gray-300">
                  {status.messageCount} /{" "}
                  {status.messageLimit === Infinity ? "∞" : status.messageLimit.toLocaleString()}
                </span>
              </div>
              {status.messageLimit !== Infinity && status.messageLimit > 0 && (
                <div className="w-full bg-gray-800 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      status.messageCount / status.messageLimit > 0.9
                        ? "bg-red-500"
                        : status.messageCount / status.messageLimit > 0.7
                          ? "bg-yellow-500"
                          : "bg-blue-500"
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
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-400">Tokens</span>
                <span className="text-gray-300">
                  {formatTokens(status.tokenUsage)} /{" "}
                  {status.tokenLimit === Infinity ? "∞" : formatTokens(status.tokenLimit)}
                </span>
              </div>
              {status.tokenLimit !== Infinity && status.tokenLimit > 0 && (
                <div className="w-full bg-gray-800 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      status.tokenUsage / status.tokenLimit > 0.9
                        ? "bg-red-500"
                        : status.tokenUsage / status.tokenLimit > 0.7
                          ? "bg-yellow-500"
                          : "bg-cyan-500"
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PLANS.map((plan) => {
          const isCurrent = status?.plan === plan.key;
          return (
            <div
              key={plan.key}
              className={`bg-gray-900 border rounded-xl p-6 flex flex-col ${
                isCurrent
                  ? "border-blue-500"
                  : plan.key === "PRO"
                    ? "border-blue-500/50 ring-1 ring-blue-500/20"
                    : "border-gray-800"
              }`}
            >
              {plan.key === "PRO" && (
                <span className="text-[10px] uppercase bg-blue-600 text-white px-2 py-0.5 rounded-full font-medium mb-2 self-start">
                  Most Popular
                </span>
              )}
              <p className="text-lg font-bold mb-1">{plan.name}</p>
              <p className="text-2xl font-bold mb-1">
                {plan.price}
                <span className="text-sm text-gray-500 font-normal">{plan.period}</span>
              </p>
              <p className="text-sm text-gray-400 mb-4">{plan.limit}</p>

              <ul className="space-y-2 mb-6 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="text-sm text-gray-300 flex items-start gap-2">
                    <span className="text-green-400 mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <div className="text-center text-sm text-blue-400 font-medium py-2">
                  Current Plan
                </div>
              ) : plan.key === "FREE" ? (
                <div />
              ) : plan.key === "ENTERPRISE" ? (
                <a
                  href="mailto:sales@hireeve.com"
                  className="block text-center bg-gray-800 hover:bg-gray-700 text-white py-2.5 rounded-lg text-sm font-medium transition"
                >
                  Contact Sales
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => handleUpgrade(plan.key as "PRO")}
                  className="bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-lg text-sm font-medium transition"
                >
                  Upgrade to {plan.name}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
