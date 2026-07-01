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

  const removeKey = async (p: Provider, label: string) => {
    const ok = await confirm({
      title: `Remove your ${label} key?`,
      message: "Klorn falls back to its shared key for your mail.",
      confirmLabel: "Remove key",
      danger: true,
    });
    if (!ok) return;
    void patchModels({ [CLEAR_FIELD[p]]: true }, p);
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
                  {set && <StatusChip status="connected" label="Using your key" />}
                </div>
                {set ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-stone-400">•••••••• stored</span>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void removeKey(p.id, p.label)}
                      disabled={working}
                      loading={working}
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <Input
                        id={`byok-key-${p.id}`}
                        label={`${p.label} API key`}
                        type="password"
                        value={inputs[p.id]}
                        onChange={(e) => setInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                        placeholder={p.placeholder}
                        autoComplete="off"
                        maxLength={512}
                      />
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => saveKey(p.id)}
                      disabled={working || !inputs[p.id].trim()}
                      loading={working}
                      className="shrink-0"
                    >
                      Save
                    </Button>
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
          {(() => {
            const anyKey = !!status?.hasOpenRouterApiKey || !!status?.hasGeminiApiKey;
            const options = status?.availableModels ?? [];
            return (
              <div className="rounded-md border border-stone-800 bg-stone-900/40 p-3">
                <Select
                  id="byok-model"
                  label="Model"
                  disabled={!anyKey || savingModel}
                  value={status?.selectedModel ?? options[0]?.id ?? ""}
                  onChange={(e) => void saveModel(e.target.value)}
                >
                  {options.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                </Select>
                {!anyKey && (
                  <p className="mt-1 text-[11px] text-stone-400">
                    Add a key above to choose a model.
                  </p>
                )}
              </div>
            );
          })()}
          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-700/40 bg-red-950/30 p-3 text-xs text-red-200"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
