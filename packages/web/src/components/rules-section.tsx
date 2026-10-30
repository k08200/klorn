/**
 * Settings › Rules — the user's tier pins, written in their own words.
 * Flow: NL text → POST /rules/compile (LLM proposes pins) → user reviews,
 * adjusts lanes, removes lines → POST /rules/pins applies with replace
 * semantics. Nothing is saved without the review step, and clauses the two
 * pin levels can't express surface verbatim under "unsupported" — never
 * silently dropped. Saved pins list from GET /rules/pins; delete goes
 * through the generic DELETE /rules/:id.
 */

import type { CompileRulesResponse, TierPinInput, TierPinsListResponse } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { isEntitlementRefusal } from "../lib/entitlement";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";
import { CORE_TIERS } from "../lib/tiers";
import { useConfirm } from "./confirm-dialog";
import { LaneChip } from "./lane-chip";
import { ProFeatureNotice } from "./pro-feature-notice";
import { useToast } from "./toast";

const RULE_TEXT_MAX = 500;

const FIELD =
  "w-full rounded-xl border border-line bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35";
const BUTTON =
  "ease-strong inline-flex min-h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink transition duration-150 hover:bg-surface-panel disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35";
const BUTTON_PRIMARY =
  "ease-strong inline-flex min-h-9 items-center rounded-lg bg-accent-solid px-3 text-xs font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35";

function pinLabel(pin: { scope: string; value: string }): string {
  return pin.scope === "domain" ? `@${pin.value}` : pin.value;
}

export function RulesSection() {
  const { t } = useT();
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [pins, setPins] = useState<TierPinsListResponse["pins"]>([]);
  const [text, setText] = useState("");
  const [compiling, setCompiling] = useState(false);
  // Compiling is Pro (one LLM call): a FREE user's 403 shows the upgrade notice.
  const [proGated, setProGated] = useState(false);
  const [proposals, setProposals] = useState<TierPinInput[] | null>(null);
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  const load = useCallback(() => {
    apiFetch<TierPinsListResponse>("/api/email/rules/pins")
      .then((d) => setPins(d.pins))
      .catch((err) => captureClientError(err, { scope: "settings.rules-list" }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const compile = async () => {
    setCompiling(true);
    setProGated(false);
    try {
      const res = await apiFetch<CompileRulesResponse>("/api/email/rules/compile", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setProposals(res.pins);
      setUnsupported(res.unsupported);
    } catch (err) {
      if (isEntitlementRefusal(err)) {
        setProGated(true);
        return;
      }
      captureClientError(err, { scope: "settings.rules-compile" });
      toast(t("settings.rules.compileFailed"), "error");
    } finally {
      setCompiling(false);
    }
  };

  const apply = async () => {
    if (!proposals?.length) return;
    setApplying(true);
    try {
      const res = await apiFetch<{ applied: unknown[] }>("/api/email/rules/pins", {
        method: "POST",
        body: JSON.stringify({ pins: proposals }),
      });
      toast(t("settings.rules.applied", { n: String(res.applied.length) }), "success");
      setProposals(null);
      setUnsupported([]);
      setText("");
      load();
    } catch (err) {
      captureClientError(err, { scope: "settings.rules-apply" });
      toast(t("settings.rules.applyFailed"), "error");
    } finally {
      setApplying(false);
    }
  };

  const deletePin = async (pin: TierPinsListResponse["pins"][number]) => {
    const ok = await confirm({
      title: t("settings.rules.deleteConfirm.title"),
      message: t("settings.rules.deleteConfirm.message", { pin: pinLabel(pin) }),
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/email/rules/${pin.id}`, { method: "DELETE" });
      toast(t("settings.rules.deleted"), "success");
      load();
    } catch (err) {
      captureClientError(err, { scope: "settings.rules-delete" });
      toast(t("settings.rules.deleteFailed"), "error");
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-mid">{t("settings.rules.intro")}</p>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={RULE_TEXT_MAX}
          rows={2}
          placeholder={t("settings.rules.placeholder")}
          className={FIELD}
        />
        <button
          type="button"
          onClick={compile}
          disabled={compiling || !text.trim()}
          className={BUTTON_PRIMARY}
        >
          {compiling ? t("settings.rules.compiling") : t("settings.rules.compile")}
        </button>
        {proGated && <ProFeatureNotice />}
      </div>

      {proposals && (
        <div className="space-y-2 rounded-xl border border-line bg-surface-raised p-3">
          <p className="text-xs font-medium text-ink-mid">{t("settings.rules.review")}</p>
          {proposals.length === 0 && unsupported.length === 0 && (
            <p className="text-sm text-ink-dim">{t("settings.rules.empty")}</p>
          )}
          <ul className="space-y-1.5">
            {proposals.map((pin, i) => (
              <li key={`${pin.scope}:${pin.value}`} className="flex items-center gap-2">
                <LaneChip tier={pin.tier} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{pinLabel(pin)}</span>
                <select
                  value={pin.tier}
                  onChange={(e) =>
                    setProposals((prev) =>
                      prev
                        ? prev.map((p, j) =>
                            j === i ? { ...p, tier: e.target.value as TierPinInput["tier"] } : p,
                          )
                        : prev,
                    )
                  }
                  aria-label={pinLabel(pin)}
                  className="rounded-lg border border-line bg-surface-panel px-2 py-1 text-xs text-ink"
                >
                  {CORE_TIERS.map((lane) => (
                    <option key={lane} value={lane}>
                      {lane}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`${t("settings.rules.cancel")}: ${pinLabel(pin)}`}
                  onClick={() =>
                    setProposals((prev) => (prev ? prev.filter((_, j) => j !== i) : prev))
                  }
                  className="text-ink-dim hover:text-ink"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {unsupported.length > 0 && (
            <div className="text-xs text-ink-dim">
              <p className="font-medium">{t("settings.rules.unsupported")}</p>
              <ul className="mt-1 list-inside list-disc">
                {unsupported.map((clause) => (
                  <li key={clause} className="truncate">
                    {clause}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={apply}
              disabled={applying || proposals.length === 0}
              className={BUTTON_PRIMARY}
            >
              {applying ? t("settings.rules.applying") : t("settings.rules.apply")}
            </button>
            <button
              type="button"
              onClick={() => {
                setProposals(null);
                setUnsupported([]);
              }}
              className={BUTTON}
            >
              {t("settings.rules.cancel")}
            </button>
          </div>
        </div>
      )}

      {pins.length === 0 ? (
        <p className="text-sm text-ink-dim">{t("settings.rules.empty")}</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {pins.map((pin) => (
            <li key={pin.id} className="flex items-center gap-2 py-2">
              <LaneChip tier={pin.tier} />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{pinLabel(pin)}</span>
              <button
                type="button"
                aria-label={`${t("settings.rules.deleteConfirm.message", { pin: pinLabel(pin) })}`}
                onClick={() => deletePin(pin)}
                className="text-xs text-ink-dim hover:text-state-danger-ink"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
