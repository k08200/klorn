/**
 * New event, in two steps: the form, then a confirm card that says exactly
 * what will be created (which calendar, who gets an invitation). Nothing is
 * written until "Create event" on the confirm step (POST /api/calendar).
 * "Fill from text" asks POST /api/calendar/parse-event for a draft — it
 * writes nothing either.
 */
import { type FormEvent, useEffect, useState } from "react";
import type { EventDraftWire } from "../../api/wire";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { PlansLink } from "../../ui/PlansLink";
import { Sheet } from "../../ui/Sheet";
import { notify } from "../../ui/StatusNote";
import { Switch } from "../../ui/Switch";
import { DraftSummary, useCreateEvent } from "./EventDraftCard";
import { type DayKey, defaultFormFor, draftFromForm, type EventForm, formFromDraft } from "./model";

interface NewEventSheetProps {
  open: boolean;
  onClose: () => void;
  day: DayKey;
  zone: string;
  now: Date;
  /** Open straight on the confirm step with this draft (a team free slot). */
  initialDraft?: EventDraftWire | null;
  onCreated?: (draft: EventDraftWire) => void;
}

const PROBLEM_KEYS: Record<"title" | "time" | "attendees", MessageKey> = {
  title: "calendar.new.problem.title",
  time: "calendar.new.problem.time",
  attendees: "calendar.new.problem.attendees",
};

export function NewEventSheet({
  open,
  onClose,
  day,
  zone,
  now,
  initialDraft,
  onCreated,
}: NewEventSheetProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<EventForm>(() => defaultFormFor(day, now, zone));
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [quick, setQuick] = useState("");
  const [parsing, setParsing] = useState(false);
  const create = useCreateEvent();

  // A fresh sheet each time it opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    const base = defaultFormFor(day, now, zone);
    setForm(initialDraft ? formFromDraft(initialDraft, base, zone) : base);
    setStep(initialDraft ? "confirm" : "form");
    setProblem(null);
    setQuick("");
    create.reset();
  }, [open]);

  const result = draftFromForm(form, zone);
  const set = (patch: Partial<EventForm>) => setForm((f) => ({ ...f, ...patch }));

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (result.problem) {
      setProblem(PROBLEM_KEYS[result.problem]);
      return;
    }
    setProblem(null);
    setStep("confirm");
  };

  const fillFromText = async () => {
    const text = quick.trim();
    if (!text) return;
    setParsing(true);
    try {
      const { event } = await getServices().ep.calendar.parseEvent(text);
      if (event) setForm((f) => formFromDraft(event, f, zone));
      else setProblem("calendar.new.parseFailed");
    } catch {
      setProblem("calendar.new.parseFailed");
    } finally {
      setParsing(false);
    }
  };

  const confirm = async () => {
    if (!result.draft) return;
    const ok = await create.save(result.draft);
    if (ok) {
      notify(
        t(result.draft.attendees?.length ? "calendar.draft.savedInvited" : "calendar.draft.saved"),
      );
      onCreated?.(result.draft);
      onClose();
    }
  };

  if (step === "confirm" && result.draft) {
    const invites = (result.draft.attendees?.length ?? 0) > 0;
    return (
      <Sheet
        closeButton
        open={open}
        onClose={onClose}
        title={t("calendar.confirm.title")}
        subtitle={t("calendar.confirm.subtitle")}
        footer={
          <>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setStep("form")}
              disabled={create.state === "saving"}
            >
              {t("calendar.confirm.edit")}
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void confirm()}
              disabled={create.state === "saving"}
              data-autofocus
            >
              {create.state === "saving"
                ? t("calendar.draft.saving")
                : t(invites ? "calendar.draft.saveInvite" : "calendar.confirm.create")}
            </button>
          </>
        }
      >
        <section className="event-draft event-draft--sheet">
          <span className="event-draft__title">{result.draft.title}</span>
          <DraftSummary draft={result.draft} zone={zone} />
        </section>
        <p className="form-field__hint">
          {t(invites ? "calendar.draft.fineInvites" : "calendar.draft.fine")}
        </p>
        {create.state === "paywalled" ? (
          <p className="form-note" role="status">
            {t("calendar.draft.paywall")} <PlansLink />
          </p>
        ) : null}
        {create.state === "error" ? (
          <p className="form-error" role="alert">
            {t("calendar.draft.error")}
          </p>
        ) : null}
      </Sheet>
    );
  }

  return (
    <Sheet
      closeButton
      open={open}
      onClose={onClose}
      title={t("calendar.new.title")}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose}>
            {t("settings.ui.cancel")}
          </button>
          <button type="submit" form="new-event-form" className="button button--primary">
            {t("calendar.new.next")}
          </button>
        </>
      }
    >
      <form id="new-event-form" className="new-event" onSubmit={next} noValidate>
        <div className="form-field">
          <label className="form-field__label" htmlFor="ne-quick">
            {t("calendar.new.quick")}
          </label>
          <span className="new-event__quick">
            <input
              id="ne-quick"
              type="text"
              value={quick}
              placeholder={t("calendar.new.quickPlaceholder")}
              onChange={(e) => setQuick(e.target.value)}
              maxLength={500}
            />
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void fillFromText()}
              disabled={!quick.trim() || parsing}
            >
              {parsing ? t("calendar.new.parsing") : t("calendar.new.fill")}
            </button>
          </span>
        </div>
        <label className="form-field">
          <span className="form-field__label">{t("calendar.new.eventTitle")}</span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            maxLength={300}
            required
            data-autofocus
          />
        </label>
        <label className="form-field">
          <span className="form-field__label">{t("calendar.new.date")}</span>
          <input
            type="date"
            value={form.day}
            onChange={(e) => e.target.value && set({ day: e.target.value })}
            required
          />
        </label>
        <label className="new-event__switch">
          <span>{t("calendar.allDay")}</span>
          <Switch checked={form.allDay} onChange={(allDay) => set({ allDay })} />
        </label>
        {form.allDay ? null : (
          <div className="form-row">
            <label className="form-field">
              <span className="form-field__label">{t("calendar.new.start")}</span>
              <input
                type="time"
                value={form.start}
                onChange={(e) => set({ start: e.target.value })}
              />
            </label>
            <label className="form-field">
              <span className="form-field__label">{t("calendar.new.end")}</span>
              <input type="time" value={form.end} onChange={(e) => set({ end: e.target.value })} />
            </label>
          </div>
        )}
        <label className="form-field">
          <span className="form-field__label">{t("calendar.new.location")}</span>
          <input
            type="text"
            value={form.location}
            onChange={(e) => set({ location: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span className="form-field__label">{t("calendar.new.attendees")}</span>
          <input
            type="email"
            inputMode="email"
            multiple
            autoCapitalize="none"
            value={form.attendees}
            placeholder="name@example.com"
            onChange={(e) => set({ attendees: e.target.value })}
          />
          <span className="form-field__hint">{t("calendar.new.attendeesHint")}</span>
        </label>
        {problem ? (
          <p className="form-error" role="alert">
            {t(problem)}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
