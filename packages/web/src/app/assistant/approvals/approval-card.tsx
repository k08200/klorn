"use client";

/**
 * ApprovalCard (productization plan P7) — one proposed action, the same card
 * at every width. It answers, top to bottom: what Klorn wants to do (the
 * action's name), to what and to whom, why, and exactly what will go out. The
 * draft is on the card, not behind a click, because approving a send sends it.
 */

import { useId } from "react";
import Button from "../../../components/ui/button";
import { useT } from "../../../lib/i18n";
import { formatRelativeIntl } from "../../../lib/text";
import type { ApprovalFact, ApprovalModel } from "./model";

/** A draft longer than this is clamped until the reader opens it. */
const CLAMP_CHARS = 320;
const CLAMP_LINES = 6;

export function isLongPreview(preview: string | null): boolean {
  if (!preview) return false;
  return preview.length > CLAMP_CHARS || preview.split("\n").length > CLAMP_LINES;
}

interface ApprovalCardProps {
  model: ApprovalModel;
  /** Picked with j / k; approve and reject keys act on this card. */
  selected: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** This card's approval is on its way to the server. */
  approving: boolean;
  /** Another card is being approved; one action runs at a time. */
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  timeZone: string;
}

export function approvalDomId(id: string): string {
  return `approval-${id}`;
}

export function ApprovalCard(props: ApprovalCardProps) {
  const { model, selected, expanded, onToggleExpanded, approving, disabled } = props;
  const { t, locale } = useT();
  const headingId = useId();
  const previewId = useId();
  const action = t(model.titleKey);
  const title = model.undo ? t("assistantHub.approvals.undoOf", { action }) : action;
  const long = isLongPreview(model.preview);

  return (
    <article
      id={approvalDomId(model.id)}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-selected={selected || undefined}
      className={`rounded-card border bg-surface-panel p-4 outline-none transition-colors duration-120 ease-fluid md:p-5 ${
        selected ? "border-accent-solid ring-1 ring-accent-solid" : "border-line"
      }`}
    >
      <div className="flex items-baseline gap-3">
        <h3 id={headingId} className="min-w-0 flex-1 text-head text-ink [word-break:keep-all]">
          {title}
        </h3>
        <time
          dateTime={model.createdAt}
          className="shrink-0 text-caption tabular-nums text-ink-muted"
        >
          {formatRelativeIntl(model.createdAt, locale, t("assistantHub.justNow"))}
        </time>
      </div>

      {model.subject && (
        <p className="mt-2 break-words text-body font-medium text-ink-strong">{model.subject}</p>
      )}
      {model.facts.length > 0 && (
        <dl className="mt-1 flex flex-col gap-0.5">
          {model.facts.map((fact) => (
            <Fact key={fact.labelKey ?? fact.label} fact={fact} timeZone={props.timeZone} />
          ))}
        </dl>
      )}

      {model.why && (
        <p className="mt-3 text-body text-ink-soft [word-break:keep-all]">
          <span className="text-ink-muted">{t("assistantHub.approvals.why")} </span>
          {model.why}
        </p>
      )}

      {model.preview && (
        <div className="mt-3 rounded-control border border-line-soft bg-surface-raised px-3 py-2">
          <p className="text-caption font-medium text-ink-muted">
            {t(
              model.sendsMail
                ? "assistantHub.approvals.preview.mail"
                : "assistantHub.approvals.preview.other",
            )}
          </p>
          <p
            id={previewId}
            className={`mt-1 whitespace-pre-wrap break-words text-body text-ink ${
              long && !expanded ? "line-clamp-6" : ""
            }`}
          >
            {model.preview}
          </p>
          {long && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-controls={previewId}
              onClick={onToggleExpanded}
              className="-ml-3"
            >
              {t(expanded ? "assistantHub.approvals.showLess" : "assistantHub.approvals.showAll")}
            </Button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex gap-2 max-sm:w-full">
          <Button
            variant="primary"
            loading={approving}
            disabled={disabled}
            onClick={props.onApprove}
            className="max-sm:flex-1"
          >
            {t(
              model.sendsMail
                ? "assistantHub.approvals.approveSend"
                : "assistantHub.approvals.approve",
            )}
          </Button>
          <Button
            variant="secondary"
            disabled={disabled || approving}
            onClick={props.onReject}
            className="max-sm:flex-1"
          >
            {t("assistantHub.approvals.reject")}
          </Button>
        </div>
        <p className="min-w-0 text-caption text-ink-muted [word-break:keep-all]">
          {t(
            model.sendsMail ? "assistantHub.approvals.sendsNow" : "assistantHub.approvals.runsNow",
          )}
        </p>
      </div>
    </article>
  );
}

function Fact({ fact, timeZone }: { fact: ApprovalFact; timeZone: string }) {
  const { t, locale } = useT();
  return (
    <div className="flex gap-2 text-body">
      <dt className="shrink-0 text-ink-muted">{fact.labelKey ? t(fact.labelKey) : fact.label}</dt>
      <dd className="min-w-0 break-words text-ink-soft">
        {fact.iso ? formatWhen(fact.iso, locale, timeZone) : fact.text}
      </dd>
    </div>
  );
}

function formatWhen(iso: string, locale: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    // An unknown zone name: the reader's own zone is the next best answer.
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  }
}
