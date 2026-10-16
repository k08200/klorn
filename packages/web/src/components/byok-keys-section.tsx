"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import Button from "./ui/button";
import ErrorAlert from "./ui/error-alert";
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
  const { t } = useT();
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
      setError(t("byok.error.status"));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
        setError(msg || t("byok.error.update"));
      } finally {
        setBusy((s) => ({ ...s, [p]: false }));
      }
    },
    [busy, loadStatus, t],
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
      title: t("byok.confirmRemove.title", { provider: label }),
      message: t("byok.confirmRemove.message"),
      confirmLabel: t("byok.confirmRemove.confirm"),
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
      setError(msg || t("byok.error.model"));
    } finally {
      setSavingModel(false);
    }
  };

  return (
    <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5">
      <header className="mb-3">
        <h2 className="text-base font-semibold text-ink">{t("byok.title")}</h2>
        <p className="mt-1 text-xs text-ink-mid">{t("byok.body")}</p>
        {status?.activeModel && (
          <p className="mt-2 text-[11px] text-ink-dim">
            {t("byok.activeModel")} <span className="text-ink-mid">{status.activeModel}</span>
          </p>
        )}
      </header>

      {loading ? (
        <div className="text-xs text-ink-dim">{t("common.loading")}</div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-line-soft bg-surface-raised/70 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{OPENROUTER.label}</span>
              {status?.hasOpenRouterApiKey && (
                <StatusChip status="connected" label={t("byok.usingYourKey")} />
              )}
            </div>
            {status?.hasOpenRouterApiKey ? (
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-ink-mid">{t("byok.stored")}</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void removeKey("openRouter", "OpenRouter")}
                  disabled={busy.openRouter}
                  loading={busy.openRouter}
                >
                  {t("common.remove")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Input
                    id="byok-key-openRouter"
                    label={t("byok.openRouterLabel")}
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
                  {t("common.save")}
                </Button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-ink-dim">
              {t("byok.openRouterHelp")}{" "}
              <a
                href={OPENROUTER.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-ink-soft"
              >
                {OPENROUTER.helpLabel}
              </a>
              .
            </p>
          </div>

          {status?.hasGeminiApiKey && (
            <div className="rounded-xl border border-state-warn-line bg-state-warn-bg p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">
                  Google Gemini{" "}
                  <span className="text-[11px] text-state-warn-ink">{t("byok.legacy")}</span>
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-ink-mid">{t("byok.geminiRetired")}</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void removeKey("gemini", "Google Gemini")}
                  disabled={busy.gemini}
                  loading={busy.gemini}
                >
                  {t("common.remove")}
                </Button>
              </div>
            </div>
          )}
          {(() => {
            const options = status?.availableModels ?? [];
            return (
              <div className="rounded-xl border border-line-soft bg-surface-raised/70 p-3">
                <Select
                  id="byok-model"
                  label={t("byok.assistantModel")}
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
                <p className="mt-1 text-[11px] text-ink-dim">{t("byok.assistantModelHelp")}</p>
              </div>
            );
          })()}
          {error && <ErrorAlert>{error}</ErrorAlert>}
        </div>
      )}
    </section>
  );
}
