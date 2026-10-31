"use client";

import { useId, useState } from "react";
import Button from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { KEY_PLACEHOLDER, KEY_URL, type PlaygroundProvider, PROVIDER_LABEL } from "./models";
import { type PlaygroundSample, SAMPLES } from "./samples";

export interface EmailDraft {
  from: string;
  subject: string;
  body: string;
}

interface SampleRowProps {
  active: PlaygroundSample["id"] | null;
  onPick: (sample: PlaygroundSample) => void;
  disabled: boolean;
}

function SampleRow({ active, onPick, disabled }: SampleRowProps) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption font-semibold uppercase tracking-wide text-ink-mid">
        {t("playground.samples.heading")}
      </span>
      <div className="flex flex-wrap gap-2">
        {SAMPLES.map((sample) => (
          <Button
            key={sample.id}
            variant="chip"
            aria-pressed={active === sample.id}
            onClick={() => onPick(sample)}
            disabled={disabled}
            className="max-md:after:-inset-y-2"
          >
            {t(`playground.samples.${sample.id}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Phone: the email collapses to this card until "Edit email". */
function EmailSummary({ draft, onEdit }: { draft: EmailDraft; onEdit: () => void }) {
  const { t } = useT();
  const empty = !draft.from.trim() && !draft.subject.trim() && !draft.body.trim();
  return (
    <div className="flex flex-col gap-3 md:hidden">
      <div className="flex flex-col gap-1 rounded-card bg-surface-raised p-3">
        {empty ? (
          <span className="text-body text-ink-mid">{t("playground.email.empty")}</span>
        ) : (
          <>
            <span className="truncate text-caption text-ink-mid">{draft.from}</span>
            <span className="truncate text-label font-semibold text-ink">{draft.subject}</span>
            <span className="line-clamp-2 text-body text-ink-soft">{draft.body}</span>
          </>
        )}
      </div>
      <Button variant="secondary" onClick={onEdit} className="w-full max-md:min-h-11">
        {t("playground.email.edit")}
      </Button>
    </div>
  );
}

function EmailFields({
  draft,
  onChange,
  phoneHidden,
  onCollapse,
}: {
  draft: EmailDraft;
  onChange: (next: EmailDraft) => void;
  phoneHidden: boolean;
  onCollapse: () => void;
}) {
  const { t } = useT();
  return (
    <div className={`flex-col gap-3 ${phoneHidden ? "hidden md:flex" : "flex"}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          id="pg-from"
          label={t("playground.field.from")}
          value={draft.from}
          onChange={(e) => onChange({ ...draft, from: e.target.value })}
          placeholder={t("playground.field.fromPlaceholder")}
          maxLength={320}
          autoComplete="off"
        />
        <Input
          id="pg-subject"
          label={t("playground.field.subject")}
          value={draft.subject}
          onChange={(e) => onChange({ ...draft, subject: e.target.value })}
          placeholder={t("playground.field.subjectPlaceholder")}
          maxLength={998}
          autoComplete="off"
        />
      </div>
      <Textarea
        id="pg-body"
        label={t("playground.field.body")}
        value={draft.body}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
        placeholder={t("playground.field.bodyPlaceholder")}
        rows={5}
        maxLength={4000}
        className="resize-y"
      />
      <Button variant="secondary" onClick={onCollapse} className="w-full md:hidden max-md:min-h-11">
        {t("playground.email.collapse")}
      </Button>
    </div>
  );
}

export function EmailSection({
  draft,
  onChange,
  activeSample,
  onPickSample,
  disabled = false,
}: {
  draft: EmailDraft;
  onChange: (next: EmailDraft) => void;
  activeSample: PlaygroundSample["id"] | null;
  onPickSample: (sample: PlaygroundSample) => void;
  /** While a sort is in flight, samples can't swap the email under it. */
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <SampleRow active={activeSample} onPick={onPickSample} disabled={disabled} />
      {!editing && <EmailSummary draft={draft} onEdit={() => setEditing(true)} />}
      <EmailFields
        draft={draft}
        onChange={onChange}
        phoneHidden={!editing}
        onCollapse={() => setEditing(false)}
      />
    </div>
  );
}

interface KeyFieldProps {
  provider: PlaygroundProvider;
  apiKey: string;
  onKeyChange: (next: string) => void;
  remember: boolean;
  onRememberChange: (next: boolean) => void;
}

export function KeyField({
  provider,
  apiKey,
  onKeyChange,
  remember,
  onRememberChange,
}: KeyFieldProps) {
  const { t } = useT();
  const [shown, setShown] = useState(false);
  const inputId = useId();
  const providerName = PROVIDER_LABEL[provider];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-label text-ink-soft">
          {t("playground.key.label", { provider: providerName })}
        </label>
        <Button
          variant="link"
          size="sm"
          aria-pressed={shown}
          aria-controls={inputId}
          onClick={() => setShown((prev) => !prev)}
          className="max-md:min-h-11"
        >
          {shown ? t("playground.key.hide") : t("playground.key.show")}
        </Button>
      </div>
      <input
        id={inputId}
        type={shown ? "text" : "password"}
        value={apiKey}
        onChange={(e) => onKeyChange(e.target.value)}
        placeholder={KEY_PLACEHOLDER[provider]}
        autoComplete="off"
        spellCheck={false}
        maxLength={400}
        className="focus-ring min-h-9 w-full rounded-card border border-line-strong bg-surface-panel px-3 font-mono text-field text-ink placeholder:text-ink-dim md:text-body max-md:min-h-11"
      />
      <label className="flex min-h-8 cursor-pointer items-center gap-2 text-label text-ink-soft max-md:min-h-11">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => onRememberChange(e.target.checked)}
          className="size-4 shrink-0 cursor-pointer accent-accent-solid"
        />
        {t("playground.key.remember")}
      </label>
      <p className="text-caption text-ink-mid">{t("playground.key.trust")}</p>
      {!apiKey && (
        <p className="text-caption text-ink-mid">
          {t("playground.key.none")}{" "}
          <a
            href={KEY_URL[provider]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-deep underline underline-offset-2"
          >
            {t("playground.key.create", { provider: providerName })}
          </a>
          {". "}
          {t("playground.key.billing", { provider: providerName })}
        </p>
      )}
    </div>
  );
}
