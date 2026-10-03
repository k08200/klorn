"use client";

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { PANEL, SECTION_TITLE } from "./shared";
import type { AutomationConfig } from "./use-automation-config";

export function RepliesPanel({ config }: { config: AutomationConfig | null }) {
  // Reply tone and notification language were backend-supported and exposed in
  // the desktop app, but had no web UI — the same account showed different
  // settings depending on which client you opened.
  const [replyTone, setReplyTone] = useState("MATCH_ME");
  const [replyTones, setReplyTones] = useState<
    Array<{ tone: string; label: string; description: string }>
  >([]);
  // Ontology v2 auto mode: BASIC = notify important+meetings only, human
  // answers; AUTO = Klorn answers eligible mail per the guideline (send is
  // additionally server-flag-gated — the UI is honest about that below).
  const [attentionMode, setAttentionMode] = useState<"BASIC" | "AUTO">("BASIC");
  const [guidelineDraft, setGuidelineDraft] = useState("");
  const [guidelineDefault, setGuidelineDefault] = useState("");
  /// Last text the server is known to hold — used to put the box back when a
  /// CLEARING save fails, so an empty field can't read as "I cleared it" while
  /// the server still has the old guideline.
  const [guidelineSaved, setGuidelineSaved] = useState("");
  const [guidelineSaving, setGuidelineSaving] = useState(false);
  const [guidelineAdvice, setGuidelineAdvice] = useState<string | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const { toast } = useToast();
  const { t } = useT();

  useEffect(() => {
    if (!config) return;
    const d = config;
    setReplyTone(d.replyTone ?? "MATCH_ME");
    if (Array.isArray(d.replyTones) && d.replyTones.length > 0) setReplyTones(d.replyTones);
    setAttentionMode(d.attentionMode === "AUTO" ? "AUTO" : "BASIC");
    setGuidelineDefault(d.autoReplyGuidelineDefault ?? "");
    setGuidelineDraft(d.autoReplyGuideline ?? d.autoReplyGuidelineDefault ?? "");
    setGuidelineSaved(d.autoReplyGuideline ?? d.autoReplyGuidelineDefault ?? "");
  }, [config]);

  const updateReplyTone = async (tone: string) => {
    const previous = replyTone;
    setReplyTone(tone);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ replyTone: tone }),
      });
    } catch {
      setReplyTone(previous);
      toast(t("settings.toast.replyToneFailed"), "error");
    }
  };

  const updateAttentionMode = async (mode: "BASIC" | "AUTO") => {
    const previous = attentionMode;
    setAttentionMode(mode);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ attentionMode: mode }),
      });
    } catch {
      setAttentionMode(previous);
      toast(t("settings.toast.attentionModeFailed"), "error");
    }
  };

  const saveGuideline = async () => {
    setGuidelineSaving(true);
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ autoReplyGuideline: guidelineDraft }),
      });
      toast(t("settings.toast.guidelineSaved"), "success");
      // Empty save = reset to the founder default (server stores null).
      const landed = guidelineDraft.trim() ? guidelineDraft : guidelineDefault;
      if (!guidelineDraft.trim() && guidelineDefault) setGuidelineDraft(guidelineDefault);
      setGuidelineSaved(landed);
    } catch {
      // A failed CLEARING save must not leave an empty box implying the
      // guideline is gone — restore what the server still holds. A failed
      // edit keeps the user's text so they can retry without retyping.
      if (!guidelineDraft.trim() && guidelineSaved) setGuidelineDraft(guidelineSaved);
      toast(t("settings.toast.guidelineFailed"), "error");
    } finally {
      setGuidelineSaving(false);
    }
  };

  const requestGuidelineAdvice = async () => {
    setAdviceLoading(true);
    setGuidelineAdvice(null);
    try {
      const res = await apiFetch<{ advice?: string }>("/api/automations/guideline-advice", {
        method: "POST",
        body: JSON.stringify({ guideline: guidelineDraft }),
      });
      if (res.advice) {
        setGuidelineAdvice(res.advice);
      } else {
        toast(t("settings.toast.adviceFailed"), "error");
      }
    } catch {
      toast(t("settings.toast.adviceFailed"), "error");
    } finally {
      setAdviceLoading(false);
    }
  };

  return (
    <section className="mb-8">
      <h2 className={SECTION_TITLE}>{t("settings.section.replies")}</h2>
      <div className={`${PANEL} divide-y divide-line-soft`}>
        <div className="p-5 space-y-3">
          <div>
            <label htmlFor="reply-tone" className="font-medium block">
              {t("settings.field.replyTone")}
            </label>
            <p className="text-sm text-ink-mid">{t("settings.field.replyToneDesc")}</p>
          </div>
          <select
            id="reply-tone"
            value={replyTone}
            onChange={(e) => updateReplyTone(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
          >
            {(replyTones.length > 0
              ? replyTones
              : [
                  {
                    tone: "MATCH_ME",
                    label: t("settings.replyTone.matchMe.label"),
                    description: t("settings.replyTone.matchMe.desc"),
                  },
                  {
                    tone: "FORMAL",
                    label: t("settings.replyTone.formal.label"),
                    description: t("settings.replyTone.formal.desc"),
                  },
                  {
                    tone: "FRIENDLY",
                    label: t("settings.replyTone.friendly.label"),
                    description: t("settings.replyTone.friendly.desc"),
                  },
                  {
                    tone: "CASUAL",
                    label: t("settings.replyTone.casual.label"),
                    description: t("settings.replyTone.casual.desc"),
                  },
                ]
            ).map((option) => (
              <option key={option.tone} value={option.tone}>
                {option.label} — {option.description}
              </option>
            ))}
          </select>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <span className="font-medium block">{t("settings.field.attentionMode")}</span>
            <p className="text-sm text-ink-mid">{t("settings.field.attentionModeDesc")}</p>
          </div>
          {/* aria-pressed toggles, not a role=radiogroup: the ARIA radio
                  pattern promises arrow-key navigation with a roving tabindex,
                  and claiming the role without it is worse for keyboard users
                  than not claiming it. Same pattern as the other pickers on
                  this page (always-allowed tools, auto-mark-read). */}
          <div className="grid grid-cols-2 gap-2">
            {(["BASIC", "AUTO"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={attentionMode === mode}
                onClick={() => updateAttentionMode(mode)}
                className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${
                  attentionMode === mode
                    ? "border-accent/60 bg-accent/5 text-ink"
                    : "border-line-strong bg-surface-panel text-ink-mid hover:border-line-strong hover:text-ink"
                }`}
              >
                <span className="font-medium block">
                  {mode === "BASIC"
                    ? t("settings.attentionMode.basic.label")
                    : t("settings.attentionMode.auto.label")}
                </span>
                <span className="text-xs text-ink-dim">
                  {mode === "BASIC"
                    ? t("settings.attentionMode.basic.desc")
                    : t("settings.attentionMode.auto.desc")}
                </span>
              </button>
            ))}
          </div>
          {attentionMode === "AUTO" && (
            <div className="space-y-2 pt-1">
              <div>
                <label htmlFor="auto-guideline" className="font-medium block text-sm">
                  {t("settings.field.autoGuideline")}
                </label>
                <p className="text-xs text-ink-dim">{t("settings.field.autoGuidelineDesc")}</p>
              </div>
              <textarea
                id="auto-guideline"
                value={guidelineDraft}
                onChange={(e) => setGuidelineDraft(e.target.value)}
                rows={5}
                maxLength={2000}
                className="w-full rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={saveGuideline}
                  disabled={guidelineSaving}
                  className="min-h-11 rounded-lg border border-accent/60 bg-accent/10 px-3 py-2 text-sm font-medium text-accent-deep hover:bg-accent/15 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                >
                  {t("settings.action.saveGuideline")}
                </button>
                <button
                  type="button"
                  onClick={requestGuidelineAdvice}
                  disabled={adviceLoading || !guidelineDraft.trim()}
                  className="min-h-11 rounded-lg border border-line-strong bg-surface-panel px-3 py-2 text-sm text-ink-mid hover:text-ink disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                >
                  {adviceLoading
                    ? t("settings.action.guidelineAdviceLoading")
                    : t("settings.action.guidelineAdvice")}
                </button>
              </div>
              {guidelineAdvice && (
                <div className="rounded-lg border border-line bg-surface-raised p-3 text-sm text-ink-mid whitespace-pre-wrap">
                  {guidelineAdvice}
                </div>
              )}
              <p className="text-xs text-ink-dim">{t("settings.autoMode.flagNote")}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
