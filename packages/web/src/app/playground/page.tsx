"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

type Tier = "PUSH" | "QUEUE" | "SILENT" | "AUTO";

interface Features {
  confidence: number;
  senderTrust: number;
  reversibility: number;
  urgency: number;
}

interface ClassifyResult {
  tier: Tier;
  reason: string;
  features: Features;
  source: "fast-path" | "sender-prior" | "llm" | "keyword-fallback";
}

// Mirrors the firewall page's tier color language so the demo reads the same
// as the real product. PUSH = interrupt (rose), QUEUE = look later (amber),
// SILENT = recorded only (stone), AUTO = handled (emerald).
const TIER_VISUAL: Record<Tier, { label: string; blurb: string; ring: string; text: string }> = {
  PUSH: {
    label: "PUSH",
    blurb: "Worth interrupting you for. A push notification would fire.",
    ring: "border-rose-400/40 bg-rose-500/10",
    text: "text-rose-300",
  },
  QUEUE: {
    label: "QUEUE",
    blurb: "Visible when you choose to look. No interruption.",
    ring: "border-amber-300/40 bg-amber-300/10",
    text: "text-amber-300",
  },
  SILENT: {
    label: "SILENT",
    blurb: "Recorded only. Klorn decided this wasn't worth surfacing.",
    ring: "border-stone-700 bg-stone-800/30",
    text: "text-stone-300",
  },
  AUTO: {
    label: "AUTO",
    blurb: "Handled without asking. Eligible for auto-execution.",
    ring: "border-emerald-400/40 bg-emerald-500/10",
    text: "text-emerald-300",
  },
};

const TIERS: Tier[] = ["PUSH", "QUEUE", "SILENT", "AUTO"];

const FREE_OPENROUTER_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-120b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
];

// Datalist for the OpenRouter model box: the free presets plus a couple of
// cheap, reliable paid models. Free models share a global pool and 429 often,
// so a paid model is the dependable choice for anyone with a little credit.
const OPENROUTER_MODEL_SUGGESTIONS = [
  ...FREE_OPENROUTER_MODELS,
  "google/gemini-2.5-flash",
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
];

type ProviderId = "openrouter" | "openai" | "gemini";

// One source of truth per provider: label, key shape, default + suggested
// models. Adding a provider is one entry here plus the matching backend slot.
const PROVIDER_META: Record<
  ProviderId,
  { label: string; keyPlaceholder: string; defaultModel: string; models: string[]; hint: string }
> = {
  openrouter: {
    label: "OpenRouter",
    keyPlaceholder: "sk-or-v1-…",
    // Default to a cheap paid model: :free SKUs share a global pool and stall
    // or 429. gpt-4o-mini is ~$0.0001/classify and responds in ~1s.
    defaultModel: "openai/gpt-4o-mini",
    models: OPENROUTER_MODEL_SUGGESTIONS,
    hint: "Default is a cheap paid model (~$0.0001/run). :free models below are free but share a global pool and often stall or 429.",
  },
  openai: {
    label: "OpenAI",
    keyPlaceholder: "sk-… or sk-proj-…",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o4-mini"],
    hint: "Your platform.openai.com key. gpt-4o-mini is cheap and reliable.",
  },
  gemini: {
    label: "Gemini",
    keyPlaceholder: "AIza…",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    hint: "Free + reliable key (no card) at aistudio.google.com/apikey.",
  },
};

const SAMPLES: Array<{ label: string; from: string; subject: string; snippet: string }> = [
  {
    label: "Investor, time-bound",
    from: "Jane Park <jane@sequoia.com>",
    subject: "Can we talk before your round closes?",
    snippet: "Saw your launch. I'd like to move fast — are you free for 20 min today or tomorrow?",
  },
  {
    label: "Newsletter",
    from: "Morning Brew <crew@morningbrew.com>",
    subject: "☕ The Fed blinked",
    snippet: "Markets rallied on rate-cut hopes. Plus: the AI bubble debate heats up. Unsubscribe.",
  },
  {
    label: "Receipt / no-reply",
    from: "Stripe <receipts@stripe.com>",
    subject: "Your receipt from Acme Inc.",
    snippet:
      "Thanks for your payment of $20.00. This is an automated message, please do not reply.",
  },
  {
    label: "Teammate asking a question",
    from: "Min <min@yourcompany.com>",
    subject: "Quick q on the deploy",
    snippet: "Did the migration run on prod yet? Want to make sure before I push the web build.",
  },
];

const PROVIDER_STORAGE = "klorn-playground-provider";
const LEGACY_KEY_STORAGE = "klorn-playground-key";
// Keys are stored PER PROVIDER. OpenRouter (sk-or-…) and Gemini (AIza…) keys
// are different credentials; sharing one slot meant switching provider sent the
// wrong key and the upstream rejected it ("API key not valid").
function keyStorageFor(provider: ProviderId): string {
  return `klorn-playground-key-${provider}`;
}

export default function PlaygroundPage() {
  const [from, setFrom] = useState(SAMPLES[0].from);
  const [subject, setSubject] = useState(SAMPLES[0].subject);
  const [snippet, setSnippet] = useState(SAMPLES[0].snippet);
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDER_META.openrouter.defaultModel);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ClassifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // Keys live only in this browser (localStorage), per provider, so a teammate
  // can reuse them across sessions without them ever touching Klorn's servers
  // beyond the single classify call. They are their own keys, on their machine.
  useEffect(() => {
    const savedProvider = localStorage.getItem(PROVIDER_STORAGE);
    const p: ProviderId =
      savedProvider === "gemini" || savedProvider === "openai" ? savedProvider : "openrouter";
    setProvider(p);
    setModel(PROVIDER_META[p].defaultModel);
    // One-time migration: the old single-slot key was the OpenRouter one.
    const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
    if (legacy && !localStorage.getItem(keyStorageFor("openrouter"))) {
      localStorage.setItem(keyStorageFor("openrouter"), legacy);
      localStorage.removeItem(LEGACY_KEY_STORAGE);
    }
    const savedKey = localStorage.getItem(keyStorageFor(p));
    if (savedKey) setApiKey(savedKey);
  }, []);

  function applySample(s: (typeof SAMPLES)[number]) {
    setFrom(s.from);
    setSubject(s.subject);
    setSnippet(s.snippet);
    setResult(null);
    setError(null);
    setFeedbackSent(false);
  }

  function onProviderChange(next: ProviderId) {
    setProvider(next);
    localStorage.setItem(PROVIDER_STORAGE, next);
    setModel(PROVIDER_META[next].defaultModel);
    // Load THIS provider's own key — never carry another provider's key over.
    setApiKey(localStorage.getItem(keyStorageFor(next)) ?? "");
    setError(null);
    setResult(null);
  }

  function onKeyChange(next: string) {
    setApiKey(next);
    if (next) localStorage.setItem(keyStorageFor(provider), next);
    else localStorage.removeItem(keyStorageFor(provider));
  }

  async function classify() {
    if (!apiKey.trim()) {
      setError("Add your own LLM key first — it stays in your browser.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setFeedbackSent(false);
    // Hard timeout so a slow/queued model (free OpenRouter SKUs often stall)
    // can't spin "Classifying…" forever — fail fast with an actionable message.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      const res = await fetch(`${API_BASE}/api/playground/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          from: from.trim(),
          subject: subject.trim(),
          snippet: snippet.trim() || undefined,
          provider,
          apiKey: apiKey.trim(),
          model: model.trim() || undefined,
        }),
      });
      if (res.status === 429) {
        setError("Too many requests — wait a minute and try again.");
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        const base = data?.error ?? "Classification failed. Check your key and model, then retry.";
        setError(data?.detail ? `${base}\n\nUpstream: ${data.detail}` : base);
        return;
      }
      setResult((await res.json()) as ClassifyResult);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError(
          "Timed out after 40s — the model is slow or queued (common with free OpenRouter models). Pick a paid model like openai/gpt-4o-mini, or use a Gemini key.",
        );
      } else {
        setError("Network error reaching the classifier. Is the API running?");
      }
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  async function sendFeedback(correctTier: Tier) {
    if (!result) return;
    setFeedbackSent(true);
    try {
      await fetch(`${API_BASE}/api/playground/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          predictedTier: result.tier,
          correctTier,
          model,
          source: result.source,
        }),
      });
    } catch {
      // Best-effort signal; never block the UI on it.
    }
  }

  return (
    <main id="main" className="min-h-screen sky-bg text-slate-900">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <Link href="/" className="text-sm font-semibold tracking-tight text-slate-900">
          Klorn
        </Link>
        <Link
          href="/early-access"
          className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:border-slate-300"
        >
          Get early access
        </Link>
      </nav>

      <div className="mx-auto max-w-5xl px-6 pb-24">
        <header className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Playground
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            See what Klorn would interrupt you for
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500">
            No login. Paste an email, bring your own LLM key, and watch the same classifier the
            firewall uses sort it into one of four tiers. Your key stays in this browser and is used
            only for this one call — it is never stored on our servers.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          {/* Left: input */}
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xl shadow-black/20">
            <div className="mb-4 flex flex-wrap gap-2">
              {SAMPLES.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => applySample(s)}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-sky-300/50 hover:text-sky-600"
                >
                  {s.label}
                </button>
              ))}
            </div>

            <label className="mb-1.5 block text-xs font-medium text-slate-500" htmlFor="pg-from">
              From
            </label>
            <input
              id="pg-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mb-3 w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus-visible:border-sky-300 focus-visible:ring-1 focus-visible:ring-sky-300/25"
              placeholder="Jane Park <jane@sequoia.com>"
            />

            <label className="mb-1.5 block text-xs font-medium text-slate-500" htmlFor="pg-subject">
              Subject
            </label>
            <input
              id="pg-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mb-3 w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus-visible:border-sky-300 focus-visible:ring-1 focus-visible:ring-sky-300/25"
              placeholder="Can we talk today?"
            />

            <label className="mb-1.5 block text-xs font-medium text-slate-500" htmlFor="pg-snippet">
              Body / snippet
            </label>
            <textarea
              id="pg-snippet"
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              rows={4}
              className="mb-4 w-full resize-y rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus-visible:border-sky-300 focus-visible:ring-1 focus-visible:ring-sky-300/25"
              placeholder="Paste the first lines of the email…"
            />

            <div className="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label
                  className="mb-1.5 block text-xs font-medium text-slate-500"
                  htmlFor="pg-provider"
                >
                  Provider
                </label>
                <select
                  id="pg-provider"
                  value={provider}
                  onChange={(e) => onProviderChange(e.target.value as ProviderId)}
                  className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none focus-visible:border-sky-300"
                >
                  {(Object.keys(PROVIDER_META) as ProviderId[]).map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_META[id].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  className="mb-1.5 block text-xs font-medium text-slate-500"
                  htmlFor="pg-model"
                >
                  Model
                </label>
                <select
                  id="pg-model"
                  value={PROVIDER_META[provider].models.includes(model) ? model : "__custom__"}
                  onChange={(e) => setModel(e.target.value === "__custom__" ? "" : e.target.value)}
                  className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-xs text-slate-900 outline-none focus-visible:border-sky-300"
                >
                  {PROVIDER_META[provider].models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
                {!PROVIDER_META[provider].models.includes(model) && (
                  <input
                    aria-label="Custom model id"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder="vendor/model-id"
                    className="mt-2 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-xs text-slate-900 outline-none placeholder:text-slate-400 focus-visible:border-sky-300"
                  />
                )}
              </div>
            </div>
            <p className="mb-4 text-[11px] text-slate-400">{PROVIDER_META[provider].hint}</p>

            <div className="mb-1.5 flex items-center justify-between">
              <label className="block text-xs font-medium text-slate-500" htmlFor="pg-key">
                Your {PROVIDER_META[provider].label} API key
              </label>
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="text-[11px] text-slate-500 transition hover:text-sky-600"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            <input
              id="pg-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => onKeyChange(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="mb-1.5 w-full rounded-md border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus-visible:border-sky-300 focus-visible:ring-1 focus-visible:ring-sky-300/25"
              placeholder={PROVIDER_META[provider].keyPlaceholder}
            />
            <p className="mb-4 text-[11px] text-slate-400">
              Stored only in this browser (localStorage), per provider. Sent once per classify,
              never saved on our servers.
            </p>

            <button
              type="button"
              onClick={classify}
              disabled={loading}
              className="flex h-11 w-full items-center justify-center rounded-md bg-sky-500 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {loading ? "Classifying…" : "Classify"}
            </button>

            {error && (
              <div
                role="alert"
                className="mt-4 whitespace-pre-line rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
              >
                {error}
              </div>
            )}
          </section>

          {/* Right: result */}
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xl shadow-black/20">
            {!result ? (
              <div className="flex h-full min-h-[300px] items-center justify-center text-center text-sm text-slate-400">
                The tier and the four scores behind it will appear here.
              </div>
            ) : (
              <div>
                <div className={`rounded-lg border p-5 ${TIER_VISUAL[result.tier].ring}`}>
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-lg font-bold tracking-tight ${TIER_VISUAL[result.tier].text}`}
                    >
                      {TIER_VISUAL[result.tier].label}
                    </span>
                    <span className="text-[11px] uppercase tracking-wide text-slate-400">
                      via {result.source}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{TIER_VISUAL[result.tier].blurb}</p>
                  <p className="mt-3 text-sm text-slate-900">“{result.reason}”</p>
                </div>

                <div className="mt-5 space-y-3">
                  {(
                    [
                      ["Confidence", result.features.confidence],
                      ["Sender trust", result.features.senderTrust],
                      ["Reversibility", result.features.reversibility],
                      ["Urgency", result.features.urgency],
                    ] as Array<[string, number]>
                  ).map(([label, value]) => (
                    <div key={label}>
                      <div className="mb-1 flex justify-between text-xs text-slate-500">
                        <span>{label}</span>
                        <span className="tabular-nums text-slate-500">{value.toFixed(2)}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-sky-300/70"
                          style={{ width: `${Math.round(value * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-6 border-t border-slate-200 pt-4">
                  {feedbackSent ? (
                    <p className="text-xs text-slate-400">
                      Thanks — noted. That helps us calibrate.
                    </p>
                  ) : (
                    <>
                      <p className="mb-2 text-xs text-slate-500">
                        Wrong tier? Tell us the right one:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {TIERS.filter((t) => t !== result.tier).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => sendFeedback(t)}
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-500 transition hover:border-sky-300/50 hover:text-sky-600"
                          >
                            Should be {t}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-xs leading-relaxed text-slate-500">
          This is a demo of the classifier on a single email you pick. The real product runs on your
          live inbox and learns your corrections over time — that's where it gets good.
        </p>
      </div>
    </main>
  );
}
