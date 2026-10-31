"use client";

/**
 * Public playground: paste one email, bring a provider key, see the lane
 * Klorn's real judge assigns and the four scores behind it. Login-free. The
 * visitor's key is sent through Klorn's API for one call and never stored
 * server-side (routes/playground.ts); in this browser it is stored only when
 * "Remember this key on this device" is ticked (key-storage.ts).
 */

import { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/button";
import ErrorAlert from "@/components/ui/error-alert";
import { useT } from "@/lib/i18n";
import { PlaygroundFooter, PlaygroundHeader } from "./chrome";
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
  const [choice, setChoice] = useState(defaultModelFor("openrouter"));
  const [customModel, setCustomModel] = useState("");
  const { loading, result, error, setError, classify, reset } = useClassify();
  const resultRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [sorts, setSorts] = useState(0);
  const { hydrate } = keys;

  useEffect(() => {
    setChoice(defaultModelFor(hydrate()));
  }, [hydrate]);

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

  async function sort() {
    const invalid =
      !draft.from.trim() || !draft.subject.trim()
        ? "playground.error.noEmail"
        : !keys.apiKey.trim()
          ? "playground.error.noKey"
          : !isValidModelId(model) || !modelFitsProvider(keys.provider, model)
            ? "playground.error.invalid"
            : null;
    if (invalid) {
      reset();
      setError({ key: invalid });
    } else {
      await classify({ ...draft, provider: keys.provider, apiKey: keys.apiKey, model });
    }
    setSorts((n) => n + 1);
  }

  return (
    <div className="min-h-screen bg-surface-app text-ink">
      <PlaygroundHeader />
      <main id="main" className="mx-auto max-w-310 px-4 pb-16 pt-8 md:px-12 md:pt-12">
        <div className="mb-6 max-w-180 md:mb-8">
          <h1 className="text-display tracking-tight text-ink">{t("playground.title")}</h1>
          <p className="mt-3 text-body text-ink-soft md:text-head md:font-normal">
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
                  <span className="mt-1 block break-words font-mono text-caption">
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
