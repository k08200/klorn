"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import Button from "./ui/button";
import { Input, Select } from "./ui/input";
import StatusChip from "./ui/status-chip";

interface CuratedModelOption {
  id: string;
  label: string;
  note: string;
}

interface ModelStatus {
  activeModel: string;
  hasOpenRouterApiKey: boolean;
  hasGeminiApiKey: boolean;
  availableModels: CuratedModelOption[];
  selectedModel: string | null;
}

// Single-key policy (2026-07-16 outage post-mortem): OpenRouter is THE BYOK
// slot — it routes every model Klorn pins, including the Gemini family. A
// second per-provider slot is exactly how a dead/free key ends up silently
// poisoning the provider chain. The legacy Gemini slot renders as remove-only
// while a stored key remains.
type Provider = "openRouter" | "gemini";

const OPENROUTER = {
  id: "openRouter" as const,
  label: "LLM key (OpenRouter)",
  placeholder: "sk-or-v1-…",
  helpUrl: "https://openrouter.ai/keys",
  helpLabel: "openrouter.ai/keys",
};

export function ByokKeysSection() {
  const { confirm } = useConfirm();
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
  const saveKey = () => {
    const key = inputs.openRouter.trim();
    if (!key) return;
    void patchModels({ openRouterApiKey: key }, "openRouter");
  };

  const removeKey = async (p: Provider, label: string) => {
    const ok = await confirm({
      title: `Remove your ${label} key?`,
      message: "Klorn falls back to its shared key for your mail.",
      confirmLabel: "Remove key",
      danger: true,
    });
    if (!ok) return;
    void patchModels(
      p === "openRouter" ? { clearOpenRouterApiKey: true } : { clearGeminiApiKey: true },
      p,
    );
  };

  const [savingModel, setSavingModel] = useState(false);
  const saveModel = async (chatModel: string) => {
    if (savingModel) return;
    setSavingModel(true);
    setError(null);
    try {
      await apiFetch("/api/billing/models", {
        method: "PATCH",
        body: JSON.stringify({ chatModel }),
      });
      await loadStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      captureClientError(err, { scope: "byok.model" });
      setError(msg || "Could not change the model.");
    } finally {
      setSavingModel(false);
    }
  };

  return (
    <section className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-5">
      <header className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">Bring your own LLM key</h2>
        <p className="mt-1 text-xs text-slate-500">
          By default your mail is classified on Klorn&apos;s shared key. Add your own provider key
          and Klorn routes <span className="text-slate-500">your</span> mail to{" "}
          <span className="text-slate-500">your</span> key and quota instead — handy if the shared
          budget is busy. Keys are stored encrypted (AES-GCM); we never log the plaintext.
        </p>
        {status?.activeModel && (
          <p className="mt-2 text-[11px] text-slate-400">
            Active model: <span className="text-slate-500">{status.activeModel}</span>
          </p>
        )}
      </header>

      {loading ? (
        <div className="text-xs text-slate-400">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-900">{OPENROUTER.label}</span>
              {status?.hasOpenRouterApiKey && (
                <StatusChip status="connected" label="Using your key" />
              )}
            </div>
            {status?.hasOpenRouterApiKey ? (
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-slate-500">•••••••• stored</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void removeKey("openRouter", "OpenRouter")}
                  disabled={busy.openRouter}
                  loading={busy.openRouter}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Input
                    id="byok-key-openRouter"
                    label="OpenRouter API key"
                    type="password"
                    value={inputs.openRouter}
                    onChange={(e) => setInputs((s) => ({ ...s, openRouter: e.target.value }))}
                    placeholder={OPENROUTER.placeholder}
                    autoComplete="off"
                    maxLength={512}
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={saveKey}
                  disabled={busy.openRouter || !inputs.openRouter.trim()}
                  loading={busy.openRouter}
                  className="shrink-0"
                >
                  Save
                </Button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-slate-400">
              One key covers every model Klorn uses — OpenRouter routes them all. The key is
              verified with the provider before it&apos;s stored. Get one at{" "}
              <a
                href={OPENROUTER.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-slate-700"
              >
                {OPENROUTER.helpLabel}
              </a>
              .
            </p>
          </div>

          {status?.hasGeminiApiKey && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">
                  Google Gemini <span className="text-[11px] text-amber-600">legacy</span>
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500">
                  Direct Gemini keys are retired — a free-tier key here silently starves
                  classification when its daily quota runs out. Remove it and use one OpenRouter key
                  instead.
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void removeKey("gemini", "Google Gemini")}
                  disabled={busy.gemini}
                  loading={busy.gemini}
                >
                  Remove
                </Button>
              </div>
            </div>
          )}
          {(() => {
            const options = status?.availableModels ?? [];
            return (
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                <Select
                  id="byok-model"
                  label="Assistant model"
                  disabled={savingModel}
                  value={status?.selectedModel ?? options[0]?.id ?? ""}
                  onChange={(e) => void saveModel(e.target.value)}
                >
                  {options.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-[11px] text-slate-400">
                  Frontier models only — this is the model your Klorn assistant talks in. It works
                  on your mail, calendar, and tasks and never searches the web. Runs under your
                  daily AI quota; add your own key above to use your own quota instead. The mail
                  firewall&apos;s classifier is tuned separately and is not affected.
                </p>
              </div>
            );
          })()}
          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
