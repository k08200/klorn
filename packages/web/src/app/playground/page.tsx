"use client";

/**
 * Public playground: paste one email, see the lane Klorn's real judge assigns
 * and the four scores behind it. Login-free, and key-free by default — the
 * sort runs on Klorn's own account, on the model Klorn's judge runs
 * (routes/playground.ts, guarded by a per-IP cap and a daily budget).
 *
 * Bringing a provider key is the explicit alternative, not the toll gate it
 * used to be (#1686): the key, provider and model fields open on request, and
 * open on their own whenever the server says a key is the way through. A
 * visitor's key is sent through Klorn's API for one call and never stored
 * server-side; in this browser it is stored only when "Remember this key on
 * this device" is ticked (key-storage.ts).
 */

import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/button";
import ErrorAlert from "@/components/ui/error-alert";
import { useT } from "@/lib/i18n";
import { PlaygroundFooter, PlaygroundHeader } from "./chrome";
import { API_KEY_MIN_LENGTH } from "./classify-wire";
import { type EmailDraft, EmailSection, KeyField } from "./email-form";
import { LaneLegend } from "./lane-legend";
import { ModelField, OTHER_MODEL } from "./model-field";
import {
  defaultModelFor,
  isValidModelId,
  modelFitsProvider,
  type PlaygroundProvider,
  PROVIDER_LABEL,
} from "./models";
import { ResultCard } from "./result-card";
import { type PlaygroundSample, SAMPLES } from "./samples";
import { CLASSIFY_TIMEOUT_SECONDS, useClassify } from "./use-classify";
import { useProviderKey } from "./use-provider-key";

const CARD = "min-w-0 rounded-sheet border border-line bg-surface-panel p-4 md:p-6";
const PHONE_QUERY = "(max-width: 767px)";
/** Static: the disclosure button's aria-controls has to name this panel. */
const BYOK_PANEL_ID = "pg-byok";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function PlaygroundPage() {
  const { t } = useT();
  const first = SAMPLES[0];
  const [draft, setDraft] = useState<EmailDraft>({
    from: first.from,
    subject: first.subject,
    body: first.body,
  });
  const [activeSample, setActiveSample] = useState<PlaygroundSample["id"] | null>(first.id);
  const keys = useProviderKey();
  const [choice, setChoice] = useState(defaultModelFor("anthropic"));
  const [customModel, setCustomModel] = useState("");
  const { loading, result, error, setError, classify, reset } = useClassify();
  const resultRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [sorts, setSorts] = useState(0);
  // Key-free is the default door. This opens on request, and on its own when a
  // remembered key is found or the server says a key is the way through.
  const [byok, setByok] = useState(false);
  const { hydrate } = keys;

  useEffect(() => {
    setChoice(defaultModelFor(hydrate()));
  }, [hydrate]);

  // A key remembered on this device means the visitor already chose BYOK once;
  // hiding the key they can see is saved would be the worse surprise.
  useEffect(() => {
    if (keys.remember) setByok(true);
  }, [keys.remember]);

  // Only the refusals the free path cannot answer on a retry (the flag being
  // dark, the day's budget spent) switch the form over. A rate limit says "try
  // again in a minute", and flipping to BYOK would answer that retry by asking
  // for a key instead — see WireError.revealByok.
  useEffect(() => {
    if (error?.revealByok) setByok(true);
  }, [error]);

  // After a sort: bring the result into view on a phone and put focus on its
  // heading (or the error), so a screen reader hears the verdict.
  useEffect(() => {
    if (sorts === 0) return;
    const region = resultRef.current;
    if (!region) return;
    if (window.matchMedia(PHONE_QUERY).matches) {
      region.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    }
    // The alert first: a validation error must not leave focus on an old result.
    const target =
      region.querySelector<HTMLElement>('[role="alert"] [tabindex="-1"]') ?? headingRef.current;
    target?.focus({ preventScroll: true });
  }, [sorts]);

  const pickSample = (sample: PlaygroundSample) => {
    setDraft({ from: sample.from, subject: sample.subject, body: sample.body });
    setActiveSample(sample.id);
    reset();
  };

  const changeDraft = (next: EmailDraft) => {
    setDraft(next);
    setActiveSample(null);
  };

  const changeProvider = (next: PlaygroundProvider) => {
    keys.changeProvider(next);
    setChoice(defaultModelFor(next));
    reset();
  };

  const model = choice === OTHER_MODEL ? customModel.trim() : choice;

  /**
   * In BYOK the key and model still have to be right before we spend the
   * visitor's money, so a half-typed key is named rather than ignored. Key-free
   * has nothing to validate but the email.
   *
   * Switching back to the free sort with a key still in the box is a deliberate
   * choice, not a slip: the control says "Use my own API key" and is unpressed,
   * and the note above it says the sort runs on Klorn's account. The key stays
   * typed so turning it back on costs nothing.
   */
  function invalidReason(): string | null {
    if (!draft.from.trim() || !draft.subject.trim()) return "playground.error.noEmail";
    if (!byok) return null;
    if (!keys.apiKey.trim()) return "playground.error.noKey";
    if (keys.apiKey.trim().length < API_KEY_MIN_LENGTH) return "playground.error.keyTooShort";
    if (!isValidModelId(model) || !modelFitsProvider(keys.provider, model)) {
      return "playground.error.invalid";
    }
    return null;
  }

  async function sort() {
    const invalid = invalidReason();
    if (invalid) {
      reset();
      setError({ key: invalid });
    } else if (byok) {
      await classify({
        mode: "byok",
        ...draft,
        provider: keys.provider,
        apiKey: keys.apiKey,
        model,
      });
    } else {
      await classify({ mode: "demo", ...draft });
    }
    setSorts((n) => n + 1);
  }

  return (
    <div className="min-h-screen bg-surface-app text-ink">
      <PlaygroundHeader />
      <main id="main" className="mx-auto max-w-310 px-4 pb-16 pt-8 md:px-12 md:pt-12">
        <div className="mb-6 max-w-180 md:mb-8">
          <h1 className="text-role-page text-ink">{t("playground.title")}</h1>
          <p className="mt-3 text-role-body text-ink-soft md:text-role-head md:font-normal">
            <span className="md:hidden">{t("playground.leadShort")}</span>
            <span className="max-md:hidden">{t("playground.lead")}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-6">
          <section
            aria-label={t("playground.form.label")}
            className={`${CARD} flex flex-[1_1_520px] flex-col gap-5`}
          >
            <EmailSection
              draft={draft}
              onChange={changeDraft}
              activeSample={activeSample}
              onPickSample={pickSample}
              disabled={loading}
            />
            <div className="h-px bg-line" />
            <div className="flex flex-col gap-2">
              {!byok && (
                <p className="text-role-caption text-ink-mid">{t("playground.demo.note")}</p>
              )}
              {/*
                A two-state switch, not a disclosure: it decides whose account
                pays, so it keeps one label and reports state through
                aria-pressed. A label that changed with the state AND an
                aria-expanded would be read as "use the free sort, expanded" —
                two different things in one breath.
              */}
              <Button
                variant="link"
                size="sm"
                aria-pressed={byok}
                aria-controls={BYOK_PANEL_ID}
                onClick={() => setByok((on) => !on)}
                disabled={loading}
                className="self-start max-md:min-h-11"
              >
                {t("playground.byok.toggle")}
              </Button>
            </div>
            <div
              id={BYOK_PANEL_ID}
              hidden={!byok}
              className={byok ? "flex flex-col gap-5" : undefined}
            >
              <ModelField
                provider={keys.provider}
                onProviderChange={changeProvider}
                choice={choice}
                onChoiceChange={setChoice}
                customModel={customModel}
                onCustomModelChange={setCustomModel}
                disabled={loading}
              />
              <KeyField
                provider={keys.provider}
                apiKey={keys.apiKey}
                onKeyChange={keys.changeKey}
                remember={keys.remember}
                onRememberChange={keys.changeRemember}
              />
            </div>
            <Button onClick={sort} loading={loading} className="w-full min-h-10 max-md:min-h-11">
              {loading ? t("playground.submitting") : t("playground.submit")}
            </Button>
          </section>
          <section
            ref={resultRef}
            aria-label={t("playground.result.label")}
            className={`${CARD} flex flex-[1_1_440px] scroll-mt-4 flex-col gap-5`}
          >
            {error && (
              <ErrorAlert title={t("playground.error.title")}>
                <span tabIndex={-1} className="outline-none">
                  {t(error.key, {
                    provider: PROVIDER_LABEL[keys.provider],
                    seconds: String(CLASSIFY_TIMEOUT_SECONDS),
                  })}
                </span>
                {error.detail && (
                  <span className="mt-1 block break-words font-mono text-role-caption">
                    {t("playground.error.upstream", { detail: error.detail })}
                  </span>
                )}
              </ErrorAlert>
            )}
            {result ? <ResultCard ref={headingRef} result={result} /> : <LaneLegend />}
          </section>
        </div>
      </main>
      <PlaygroundFooter />
    </div>
  );
}
