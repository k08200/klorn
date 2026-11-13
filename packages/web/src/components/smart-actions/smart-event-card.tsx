"use client";

// "Add to calendar" → the event confirm card (EventConfirmFrame, shared with
// chat's event drafts) → Save. The proposal never writes. The card shows the
// date, start time and time zone read from the mail, and the sentence they
// came from; where the mail is ambiguous (no AM/PM, no day, no time) the card
// asks and Save stays disabled until the user answers. An event already at that
// time is named before anything is added.

import type {
  SmartEventCreateResponse,
  SmartEventProposalResponse,
  SmartEventProposalWire,
} from "@klorn/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { apiFetch } from "../../lib/api";
import { isEntitlementRefusal } from "../../lib/entitlement";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { EventConfirmFrame, type EventSaveOutcome } from "../event-draft-card";
import Button from "../ui/button";
import {
  canSaveEvent,
  duplicateFromError,
  type EventChoice,
  eventSaveRequest,
  initialEventChoice,
  REMINDER_CHIP_MINUTES,
  smartActionPath,
  twelveHourLabel,
  withDateTime,
} from "./model";

const FIELD_CLASS =
  "focus-ring mt-1 min-h-11 w-full rounded-control border border-line bg-surface-raised px-3 py-2 text-role-body text-ink";
const QUESTION_KEYS = {
  meridiem: "smartActions.event.askMeridiem",
  time: "smartActions.event.askTime",
  date: "smartActions.event.askDate",
  when: "smartActions.event.askWhen",
} as const;

function Field({
  label,
  children,
  htmlFor,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <label htmlFor={htmlFor} className="block text-role-label text-ink">
        {label}
      </label>
      {children}
    </div>
  );
}

function ProposalCard({
  emailId,
  proposal,
}: {
  emailId: string;
  proposal: SmartEventProposalWire;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const ids = useId();
  const [choice, setChoice] = useState<EventChoice>(() => initialEventChoice(proposal));
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const question = proposal.question;
  const update = (change: Partial<EventChoice>) => setChoice((prev) => ({ ...prev, ...change }));
  const updateSlot = (change: { date?: string; time?: string }) =>
    setChoice((prev) => withDateTime(prev, change));

  const save = async (): Promise<EventSaveOutcome> => {
    try {
      const saved = await apiFetch<SmartEventCreateResponse>(smartActionPath(emailId, "event"), {
        method: "POST",
        body: JSON.stringify(eventSaveRequest(choice)),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
      setSavedNote(
        choice.reminderMinutes !== null && !saved.reminderSet
          ? t("smartActions.event.reminderNotSet")
          : null,
      );
      return "saved";
    } catch (err) {
      if (isEntitlementRefusal(err)) return "paywalled";
      const existing = duplicateFromError(err);
      if (existing) {
        update({ existing });
        return "retry";
      }
      throw err;
    }
  };

  const duplicate = choice.existing[0];
  const savedSummary = (
    <div className="mt-1.5">
      <p className="font-medium text-ink">{choice.title.trim()}</p>
      <p className="mt-0.5 text-ink-mid">
        {t("smartActions.event.savedWhen", {
          date: choice.date,
          time: choice.time,
          zone: proposal.timeZone,
        })}
      </p>
    </div>
  );
  return (
    <EventConfirmFrame
      save={save}
      canSave={canSaveEvent(choice)}
      saveHint={t("smartActions.event.saveHint")}
      saveLabel={duplicate ? t("smartActions.event.addAnyway") : undefined}
      savedNote={savedNote}
      savedSummary={savedSummary}
    >
      <figure className="mt-2 border-l-2 border-line pl-2">
        <figcaption className="text-role-caption text-ink-muted">
          {t("smartActions.event.quote")}
        </figcaption>
        <blockquote className="mt-0.5 whitespace-pre-wrap text-ink [word-break:keep-all]">
          {proposal.quote}
        </blockquote>
      </figure>

      {question && (
        <p className="mt-2 font-medium text-ink" role="status">
          {t(QUESTION_KEYS[question.kind])}
        </p>
      )}
      {question?.kind === "meridiem" && (
        <fieldset className="mt-1 flex flex-wrap gap-2">
          <legend className="sr-only">{t("smartActions.event.askMeridiem")}</legend>
          {(["am", "pm"] as const).map((half) => (
            <Button
              key={half}
              variant={choice.time === question[half] ? "primary" : "secondary"}
              size="sm"
              aria-pressed={choice.time === question[half]}
              onClick={() => updateSlot({ time: question[half] })}
            >
              {t(`smartActions.event.${half}`, { time: twelveHourLabel(question[half]) })}
            </Button>
          ))}
        </fieldset>
      )}

      <Field label={t("newEvent.title")} htmlFor={`${ids}-title`}>
        <input
          id={`${ids}-title`}
          type="text"
          value={choice.title}
          maxLength={200}
          onChange={(e) => update({ title: e.target.value })}
          className={FIELD_CLASS}
        />
      </Field>
      <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        <Field label={t("newEvent.date")} htmlFor={`${ids}-date`}>
          <input
            id={`${ids}-date`}
            type="date"
            value={choice.date}
            onChange={(e) => updateSlot({ date: e.target.value })}
            className={FIELD_CLASS}
          />
        </Field>
        <Field label={t("newEvent.starts")} htmlFor={`${ids}-time`}>
          <input
            id={`${ids}-time`}
            type="time"
            value={choice.time}
            onChange={(e) => updateSlot({ time: e.target.value })}
            className={FIELD_CLASS}
          />
        </Field>
        <Field label={t("smartActions.event.durationLabel")} htmlFor={`${ids}-duration`}>
          <input
            id={`${ids}-duration`}
            type="number"
            min={5}
            max={1440}
            step={5}
            value={choice.durationMinutes > 0 ? choice.durationMinutes : ""}
            onChange={(e) => {
              // An emptied field is 0, which keeps Save disabled until a length is typed.
              const minutes = Number.parseInt(e.target.value, 10);
              setChoice((prev) => ({
                ...prev,
                durationMinutes: Number.isFinite(minutes) ? minutes : 0,
                existing: [],
              }));
            }}
            className={FIELD_CLASS}
          />
        </Field>
        <Field label={t("newEvent.location")} htmlFor={`${ids}-location`}>
          <input
            id={`${ids}-location`}
            type="text"
            value={choice.location}
            maxLength={200}
            onChange={(e) => update({ location: e.target.value })}
            className={FIELD_CLASS}
          />
        </Field>
      </div>
      <p className="mt-1 text-role-caption text-ink-muted">
        {t("smartActions.event.timeZone", { zone: proposal.timeZone })}
      </p>

      {duplicate && (
        <p className="mt-2 text-state-warn-ink" role="alert">
          {t("smartActions.event.duplicate", { title: duplicate.title })}
        </p>
      )}

      <div className="mt-2">
        <Button
          variant={choice.reminderMinutes !== null ? "primary" : "chip"}
          size="sm"
          aria-pressed={choice.reminderMinutes !== null}
          onClick={() =>
            update({
              reminderMinutes: choice.reminderMinutes === null ? REMINDER_CHIP_MINUTES : null,
            })
          }
        >
          {t("smartActions.event.reminder")}
        </Button>
      </div>
    </EventConfirmFrame>
  );
}

export function SmartEventCard({ emailId }: { emailId: string }) {
  const { t } = useT();
  const proposal = useQuery({
    queryKey: queryKeys.smartActions.eventProposal(emailId),
    queryFn: () =>
      apiFetch<SmartEventProposalResponse>(smartActionPath(emailId, "event-proposal"), {
        method: "POST",
      }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

  if (proposal.isPending) {
    return (
      <p className="mt-2 text-role-caption text-ink-mid" role="status">
        {t("smartActions.event.reading")}
      </p>
    );
  }
  if (proposal.isError) {
    return (
      <p className="mt-2 text-state-danger-ink" role="alert">
        {t("smartActions.event.error")}
      </p>
    );
  }
  if (!proposal.data.proposal) {
    return (
      <p className="mt-2 text-role-caption text-ink-mid" role="status">
        {t("smartActions.event.none")}
      </p>
    );
  }
  return <ProposalCard emailId={emailId} proposal={proposal.data.proposal} />;
}
