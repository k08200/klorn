"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";

interface ModelStatus {
  activeModel: string;
  hasOpenRouterApiKey: boolean;
  hasGeminiApiKey: boolean;
}

type Provider = "openRouter" | "gemini";

interface ProviderSpec {
  id: Provider;
  label: string;
  placeholder: string;
  helpUrl: string;
  helpLabel: string;
}

// Field names match the PATCH /api/billing/models body (billing.ts).
const PROVIDERS: ProviderSpec[] = [
  {
    id: "openRouter",
    label: "OpenRouter",
    placeholder: "sk-or-v1-…",
    helpUrl: "https://openrouter.ai/keys",
    helpLabel: "openrouter.ai/keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    placeholder: "AIza…",
    helpUrl: "https://aistudio.google.com/apikey",
    helpLabel: "aistudio.google.com/apikey",
  },
];

const KEY_FIELD: Record<Provider, "openRouterApiKey" | "geminiApiKey"> = {
  openRouter: "openRouterApiKey",
  gemini: "geminiApiKey",
};
const CLEAR_FIELD: Record<Provider, "clearOpenRouterApiKey" | "clearGeminiApiKey"> = {
  openRouter: "clearOpenRouterApiKey",
  gemini: "clearGeminiApiKey",
};

export function ByokKeysSection() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<Provider, string>>({ openRouter: "", gemini: "" });
  // Per-provider busy so saving one key never locks the other's controls.
  const [busy, setBusy] = useState<Record<Provider, boolean>>({
    openRouter: false,
    gemini: false,
  });

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await apiFetch<ModelStatus>("/api/billing/models"));
    } catch (err) {
      captureClientError(err, { scope: "byok.status" });
      setError("Could not load your LLM key status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const hasKey = (p: Provider) =>
    p === "openRouter" ? !!status?.hasOpenRouterApiKey : !!status?.hasGeminiApiKey;

  const patchModels = useCallback(
    async (body: Record<string, string | boolean>, p: Provider) => {
      if (busy[p]) return;
      setBusy((s) => ({ ...s, [p]: true }));
      setError(null);
      try {
        await apiFetch("/api/billing/models", { method: "PATCH", body: JSON.stringify(body) });
        setInputs((s) => ({ ...s, [p]: "" }));
        await loadStatus();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        captureClientError(err, { scope: "byok.save" });
        setError(msg || "Could not update the key.");
      } finally {
        setBusy((s) => ({ ...s, [p]: false }));
      }
    },
    [busy, loadStatus],
  );

  // Errors are handled inside patchModels; void the promise so the click
  // handlers stay synchronous (no floating promise).
  const saveKey = (p: Provider) => {
    const key = inputs[p].trim();
    if (!key) return;
    void patchModels({ [KEY_FIELD[p]]: key }, p);
  };

  const removeKey = (p: Provider, label: string) => {
    if (!confirm(`Remove your ${label} key? Klorn falls back to its shared key.`)) return;
    void patchModels({ [CLEAR_FIELD[p]]: true }, p);
  };

  return (
    <section className="rounded-xl border border-stone-800 bg-stone-950/40 p-5">
      <header className="mb-3">
        <h2 className="text-base font-semibold text-stone-100">Bring your own LLM key</h2>
        <p className="mt-1 text-xs text-stone-400">
          By default your mail is classified on Klorn&apos;s shared key. Add your own provider key
          and Klorn routes <span className="text-stone-300">your</span> mail to{" "}
          <span className="text-stone-300">your</span> key and quota instead — handy if the shared
          budget is busy. Keys are stored encrypted (AES-GCM); we never log the plaintext.
        </p>
        {status?.activeModel && (
          <p className="mt-2 text-[11px] text-stone-500">
            Active model: <span className="text-stone-300">{status.activeModel}</span>
          </p>
        )}
      </header>

      {loading ? (
        <div className="text-xs text-stone-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          {PROVIDERS.map((p) => {
            const set = hasKey(p.id);
            const working = busy[p.id];
            return (
              <div key={p.id} className="rounded-md border border-stone-800 bg-stone-900/40 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-stone-200">{p.label}</span>
                  {set && (
                    <span className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                      Using your key
                    </span>
                  )}
                </div>
                {set ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-stone-500">•••••••• stored</span>
                    <button
                      type="button"
                      onClick={() => removeKey(p.id, p.label)}
                      disabled={working}
                      className="rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-50"
                    >
                      {working ? "Removing…" : "Remove"}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <label htmlFor={`byok-key-${p.id}`} className="sr-only">
                      {p.label} API key
                    </label>
                    <input
                      id={`byok-key-${p.id}`}
                      type="password"
                      value={inputs[p.id]}
                      onChange={(e) => setInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                      placeholder={p.placeholder}
                      autoComplete="off"
                      maxLength={512}
                      className="w-full rounded-md border border-stone-700 bg-stone-900/60 px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500/60 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => saveKey(p.id)}
                      disabled={working || !inputs[p.id].trim()}
                      className="shrink-0 rounded-md border border-amber-500/60 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {working ? "Saving…" : "Save"}
                    </button>
                  </div>
                )}
                <p className="mt-1.5 text-[11px] text-stone-500">
                  Get a key at{" "}
                  <a
                    href={p.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-stone-300"
                  >
                    {p.helpLabel}
                  </a>
                  .
                </p>
              </div>
            );
          })}
          {error && (
            <div className="rounded-md border border-red-700/40 bg-red-950/30 p-3 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
