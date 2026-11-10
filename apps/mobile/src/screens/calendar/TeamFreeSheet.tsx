/**
 * "Team free time" (팀 빈 시간): the first common free slots for a saved team
 * over the next week (GET /api/teams/:id/availability — read-only), as the
 * Assistant artboard's slot picker. "Draft the invite" hands the chosen slot
 * to the New event confirm step; nothing is written from here. Team mode is
 * gated on the server: the Calendar header hides this when /api/teams is 403.
 */
import type { TeamWire } from "@klorn/contract";
import { useMemo, useState } from "react";
import { useTeamSlots } from "../../api/queries-hub";
import type { EventDraftWire } from "../../api/wire";
import { useI18n } from "../../i18n/I18nProvider";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { ProblemState, SkeletonRows } from "../../ui/StateView";
import { AttendeeRow } from "./EventDraftCard";
import { slotLabel } from "./model";

const DURATIONS = [30, 60, 90] as const;
const WINDOW_DAYS = 7;

interface TeamFreeSheetProps {
  open: boolean;
  onClose: () => void;
  teams: readonly TeamWire[];
  zone: string;
  now: Date;
  onDraft: (draft: EventDraftWire) => void;
}

export function TeamFreeSheet({ open, onClose, teams, zone, now, onDraft }: TeamFreeSheetProps) {
  const { t, tn, intlTag } = useI18n();
  const [teamId, setTeamId] = useState<string | null>(teams[0]?.id ?? null);
  const [minutes, setMinutes] = useState<number>(60);
  const [picked, setPicked] = useState(0);
  const team = teams.find((x) => x.id === teamId) ?? teams[0] ?? null;
  // The window starts at the next half hour, so a slot is never in the past.
  const window = useMemo(() => {
    const start = new Date(Math.ceil(now.getTime() / 1_800_000) * 1_800_000);
    return { start, end: new Date(start.getTime() + WINDOW_DAYS * 86_400_000) };
    // biome-ignore lint/correctness/useExhaustiveDependencies: one window per opening
  }, [open]);
  const slots = useTeamSlots(open && team ? team.id : null, window.start, window.end, minutes);
  const list = slots.data?.slots ?? [];
  const chosen = list[Math.min(picked, Math.max(0, list.length - 1))];

  const draft = (): EventDraftWire | null =>
    chosen && team
      ? {
          title: t("calendar.team.meetingTitle", { team: team.name }),
          startTime: chosen.startTime,
          endTime: chosen.endTime,
          attendees: team.members,
        }
      : null;

  return (
    <Sheet
      closeButton
      open={open}
      onClose={onClose}
      title={t("calendar.team.title")}
      subtitle={t("calendar.team.subtitle")}
      footer={
        <button
          type="button"
          className="button button--ink"
          disabled={!chosen}
          onClick={() => {
            const d = draft();
            if (d) onDraft(d);
          }}
        >
          {t("calendar.team.draft")}
          <Icon name="arrowRight" size={16} strokeWidth={2} />
        </button>
      }
    >
      {teams.length === 0 ? (
        <p className="form-note">{t("calendar.team.none")}</p>
      ) : (
        <>
          {teams.length > 1 ? (
            <div className="chip-row" role="radiogroup" aria-label={t("calendar.team.which")}>
              {teams.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={x.id === team?.id}
                  className="chip"
                  onClick={() => {
                    setTeamId(x.id);
                    setPicked(0);
                  }}
                >
                  {x.name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="chip-row" role="radiogroup" aria-label={t("calendar.team.duration")}>
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={d === minutes}
                className="chip"
                onClick={() => {
                  setMinutes(d);
                  setPicked(0);
                }}
              >
                {tn("calendar.team.minutes", d)}
              </button>
            ))}
          </div>
          {slots.isPending ? (
            <SkeletonRows rows={3} />
          ) : slots.isError ? (
            <ProblemState kind="error" onRetry={() => void slots.refetch()} compact />
          ) : list.length === 0 ? (
            <p className="form-note">{t("calendar.team.noSlots")}</p>
          ) : (
            <fieldset className="slots">
              <legend className="sr-only">{t("calendar.team.pick")}</legend>
              {list.map((slot, i) => (
                <label key={slot.startTime} className="slots__row">
                  <input
                    type="radio"
                    name="team-slot"
                    checked={i === picked}
                    onChange={() => setPicked(i)}
                  />
                  <span className="slots__text">
                    <span className="slots__when">
                      {slotLabel(slot.startTime, slot.endTime, intlTag, zone)}
                    </span>
                    <span className="slots__note">
                      {i === 0 ? t("calendar.team.earliest") : t("calendar.team.allFree")}
                    </span>
                  </span>
                  {i === 0 ? <span className="slots__best">{t("calendar.team.best")}</span> : null}
                </label>
              ))}
            </fieldset>
          )}
          {team ? <AttendeeRow attendees={team.members} note={t("calendar.team.basis")} /> : null}
          {slots.data?.unknownMembers.length ? (
            <p className="form-field__hint">
              {t("calendar.team.unknown", { people: slots.data.unknownMembers.join(", ") })}
            </p>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
