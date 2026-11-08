/**
 * The confirm card for an event that is not written yet — from the assistant
 * (chat's eventDraft), a team free slot, or the New event form. It says
 * exactly what saving does (which calendar, who is invited); nothing is
 * written until the user taps Save, through the same Pro-gated POST
 * /api/calendar the web uses. Chat itself never writes (chat-engine.ts).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EventDraftWire } from "../../api/wire";
import { getServices } from "../../app/services";
import { useI18n } from "../../i18n/I18nProvider";
import { hapticSuccess } from "../../platform/haptics";
import { Icon } from "../../ui/Icon";
import { PlansLink } from "../../ui/PlansLink";
import { saveStateAfterFailure, slotDay, slotLabel } from "./model";

export type SaveState = "idle" | "saving" | "saved" | "paywalled" | "error";

export function useCreateEvent() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState>("idle");
  const save = async (draft: EventDraftWire): Promise<boolean> => {
    setState("saving");
    try {
      await getServices().ep.calendar.create(draft);
      hapticSuccess();
      setState("saved");
      await queryClient.invalidateQueries({ queryKey: ["calendar"] });
      return true;
    } catch (err) {
      setState(saveStateAfterFailure(err));
      return false;
    }
  };
  return { state, save, reset: () => setState("idle") };
}

function initialOf(email: string): string {
  return (email.split("@")[0]?.[0] ?? "?").toUpperCase();
}

/** Who gets invited, as initials plus addresses (never colour alone). */
export function AttendeeRow({ attendees, note }: { attendees: readonly string[]; note?: string }) {
  return (
    <span className="attendees">
      <span className="attendees__faces" aria-hidden="true">
        {attendees.slice(0, 5).map((a, i) => (
          <span key={a} className={`attendees__face attendees__face--${i % 4}`}>
            {initialOf(a)}
          </span>
        ))}
      </span>
      <span className="attendees__note">{note ?? attendees.join(", ")}</span>
    </span>
  );
}

interface DraftSummaryProps {
  draft: EventDraftWire;
  zone: string;
}

/** The facts of a draft, as labelled lines. */
export function DraftSummary({ draft, zone }: DraftSummaryProps) {
  const { t, tn, intlTag } = useI18n();
  const when = draft.allDay
    ? `${slotDay(draft.startTime, intlTag, zone)} · ${t("calendar.allDay")}`
    : slotLabel(draft.startTime, draft.endTime, intlTag, zone);
  return (
    <dl className="draft-facts">
      <div>
        <dt>{t("calendar.draft.when")}</dt>
        <dd>{when}</dd>
      </div>
      {draft.location ? (
        <div>
          <dt>{t("calendar.draft.where")}</dt>
          <dd>{draft.location}</dd>
        </div>
      ) : null}
      {draft.attendees?.length ? (
        <div>
          <dt>{t("calendar.draft.invites")}</dt>
          <dd>
            <AttendeeRow
              attendees={draft.attendees}
              note={tn("calendar.draft.inviteCount", draft.attendees.length)}
            />
          </dd>
        </div>
      ) : null}
      <div>
        <dt>{t("calendar.draft.calendar")}</dt>
        <dd>{t("calendar.draft.primaryCalendar")}</dd>
      </div>
    </dl>
  );
}

export function EventDraftCard({
  draft,
  zone,
  onNavigate,
}: {
  draft: EventDraftWire;
  zone: string;
  /** Runs when a link in the card (See plans) is followed; a sheet closes itself with it. */
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const { state, save } = useCreateEvent();
  const invites = (draft.attendees?.length ?? 0) > 0;
  return (
    <section className="event-draft" aria-label={t("calendar.draft.label")}>
      <span className="event-draft__badge">{t("calendar.draft.badge")}</span>
      <span className="event-draft__title">{draft.title}</span>
      <DraftSummary draft={draft} zone={zone} />
      {state === "saved" ? (
        <span className="event-draft__done" role="status">
          <Icon name="check" size={16} strokeWidth={2.2} />
          {t(invites ? "calendar.draft.savedInvited" : "calendar.draft.saved")}
        </span>
      ) : state === "paywalled" ? (
        <p className="event-draft__paywall" role="status">
          {t("calendar.draft.paywall")} <PlansLink onNavigate={onNavigate} />
        </p>
      ) : (
        <>
          <p className="event-draft__fine">
            {t(invites ? "calendar.draft.fineInvites" : "calendar.draft.fine")}
          </p>
          <button
            type="button"
            className="button event-draft__save"
            disabled={state === "saving"}
            onClick={() => void save(draft)}
          >
            {state === "saving"
              ? t("calendar.draft.saving")
              : t(invites ? "calendar.draft.saveInvite" : "calendar.draft.save")}
            <Icon name="arrowRight" size={16} strokeWidth={2} />
          </button>
          {state === "error" ? (
            <p className="form-error" role="alert">
              {t("calendar.draft.error")}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
