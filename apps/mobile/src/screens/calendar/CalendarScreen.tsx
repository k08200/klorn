/**
 * Calendar (Calendar artboard): the month as a large title, a week strip you
 * swipe between weeks, and the selected day's agenda across every connected
 * calendar — source legend, current-time line, past events dimmed, conflicts
 * with a hand-off to the assistant. An event opens in the detail pane (or on
 * its own on phones); the selection lives in the route (/calendar/:id).
 *
 * Writes: only "New event" and a team free slot, both through the confirm
 * card and POST /api/calendar. Linked calendars are read-only mirrors.
 */
import type { InboxPurpose } from "@klorn/contract";
import { type TouchEvent, useEffect, useMemo, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { useInboxes, useMe } from "../../api/queries";
import {
  useCalendarEvent,
  useCalendarRange,
  useLinkedCalendars,
  useTeams,
} from "../../api/queries-hub";
import type { CalendarEventWire, EventDraftWire } from "../../api/wire";
import { formatRelativeFromNow } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import { ListDetail } from "../../layout/ListDetail";
import { openExternal } from "../../platform/external";
import { useLinkProps, useRouter } from "../../router/Router";
import { Icon } from "../../ui/Icon";
import { EmptyState, OfflineBanner, ProblemState, SkeletonRows } from "../../ui/StateView";
import { useNow } from "../../ui/useNow";
import { useOnline } from "../../ui/useOnline";
import { handOffToAssistant } from "../assistant/handoff";
import { isKnownZone, isOngoing, meetingService } from "../today/model";
import {
  addDays,
  agendaTime,
  busyDays,
  type Conflict,
  conflictsOf,
  type DayKey,
  dayKeyOf,
  dayLong,
  dayOfMonth,
  eventsOnDay,
  isPast,
  legendOf,
  monthTitle,
  nowLineIndex,
  overlapOf,
  sourceOf,
  weekdayLong,
  weekdayShort,
  weekOf,
  weekRange,
  weekStartsOn,
} from "./model";
import { NewEventSheet } from "./NewEventSheet";
import { legendName, purposeOfLinked, sourceColor, sourceName } from "./sources";
import { TeamFreeSheet } from "./TeamFreeSheet";
import "./calendar.css";

function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Everything a row needs to name and colour its source. */
function useSourceContext() {
  const inboxes = useInboxes().data?.inboxes ?? [];
  const linked = useLinkedCalendars("google").data ?? null;
  const primaryPurpose: InboxPurpose | null =
    inboxes.find((i) => i.kind === "primary")?.purpose ?? null;
  return {
    primaryPurpose,
    purposeOf: (e: CalendarEventWire): InboxPurpose | null =>
      e.sourceAccountId && (e.provider ?? "GOOGLE") === "GOOGLE"
        ? purposeOfLinked(e.sourceAccountId, linked, inboxes)
        : null,
    /** The same, for a legend entry (a linked Google calendar keyed by its account id). */
    purposeOfSource: (key: string, provider: string): InboxPurpose | null =>
      key !== "primary" && provider === "GOOGLE" ? purposeOfLinked(key, linked, inboxes) : null,
  };
}

// ── Header + week strip ─────────────────────────────────────────────────────

function WeekStrip({
  days,
  selected,
  today,
  busy,
  onSelect,
  onShift,
}: {
  days: DayKey[];
  selected: DayKey;
  today: DayKey;
  busy: Set<DayKey>;
  onSelect: (day: DayKey) => void;
  onShift: (weeks: number) => void;
}) {
  const { t, intlTag } = useI18n();
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const p = e.touches[0];
    touch.current = p ? { x: p.clientX, y: p.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touch.current;
    const p = e.changedTouches[0];
    touch.current = null;
    if (!start || !p) return;
    const dx = p.clientX - start.x;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(p.clientY - start.y) * 1.5) {
      onShift(dx < 0 ? 1 : -1);
    }
  };
  return (
    <div className="week" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <button type="button" className="week__shift" onClick={() => onShift(-1)}>
        <Icon name="chevronLeft" size={20} strokeWidth={2} label={t("calendar.prevWeek")} />
      </button>
      <ul className="week__days" aria-label={t("calendar.week")}>
        {days.map((day) => {
          const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
          const weekend = weekday === 0 || weekday === 6;
          const isToday = day === today;
          const isSelected = day === selected;
          return (
            <li key={day}>
              <button
                type="button"
                className="week__day"
                data-today={isToday || undefined}
                data-selected={isSelected || undefined}
                data-weekend={weekend || undefined}
                aria-pressed={isSelected}
                aria-current={isToday ? "date" : undefined}
                aria-label={`${dayLong(day, intlTag)}${busy.has(day) ? `, ${t("calendar.busy")}` : ""}`}
                onClick={() => onSelect(day)}
              >
                <span className="week__dow">{weekdayShort(day, intlTag)}</span>
                <span className="week__num">{dayOfMonth(day)}</span>
                <span className="week__dot" data-on={busy.has(day) || undefined} />
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="week__shift" onClick={() => onShift(1)}>
        <Icon name="chevronRight" size={20} strokeWidth={2} label={t("calendar.nextWeek")} />
      </button>
    </div>
  );
}

function CalendarHeader({
  selected,
  today,
  onToday,
  teamAvailable,
  onTeam,
  onNew,
}: {
  selected: DayKey;
  today: DayKey;
  onToday: () => void;
  teamAvailable: boolean;
  onTeam: () => void;
  onNew: () => void;
}) {
  const { t, intlTag } = useI18n();
  const { month, year } = monthTitle(selected, intlTag);
  return (
    <div className="cal-head__row">
      <div className="cal-head__titles">
        <span className="cal-head__year">
          {year}
          {selected !== today ? (
            <button type="button" className="cal-head__today" onClick={onToday}>
              {t("calendar.jumpToday")}
            </button>
          ) : null}
        </span>
        <h1 className="cal-head__month">
          <span className="sr-only">{t("tab.calendar")} · </span>
          {month}
        </h1>
      </div>
      <div className="cal-head__actions">
        {teamAvailable ? (
          <button type="button" className="team-pill" onClick={onTeam}>
            <Icon name="people" size={16} strokeWidth={1.9} />
            {t("calendar.team.button")}
          </button>
        ) : null}
        <button type="button" className="round-button" onClick={onNew}>
          <span className="round-button__face">
            <Icon name="plus" size={18} strokeWidth={2.2} label={t("calendar.new.title")} />
          </span>
        </button>
      </div>
    </div>
  );
}

// ── Agenda ──────────────────────────────────────────────────────────────────

function AgendaRow({
  event,
  now,
  zone,
  conflict,
  selected,
  showNowBefore,
  ctx,
}: {
  event: CalendarEventWire;
  now: Date;
  zone: string;
  conflict: Conflict | undefined;
  selected: boolean;
  showNowBefore: boolean;
  ctx: ReturnType<typeof useSourceContext>;
}) {
  const { t, intlTag } = useI18n();
  const { navigate } = useRouter();
  const link = useLinkProps({ name: "calendar", id: event.id });
  const source = sourceOf(event, ctx.primaryPurpose);
  const color = sourceColor(source, ctx.purposeOf(event));
  const past = isPast(event, now);
  const service = meetingService(event.meetingLink);
  const meta = [sourceName(source, t), service ?? event.location].filter(Boolean).join(" · ");
  return (
    <li className="agenda__item">
      {showNowBefore ? <NowLine now={now} zone={zone} /> : null}
      <div
        className="agenda__row"
        data-past={past || undefined}
        data-conflict={conflict ? true : undefined}
        data-selected={selected || undefined}
      >
        <span className="agenda__time">
          {event.allDay ? (
            <span className="agenda__start">{t("calendar.allDay")}</span>
          ) : (
            <>
              <span className="agenda__start">
                {agendaTime(new Date(event.startTime), intlTag, zone)}
              </span>
              <span className="agenda__end">
                {agendaTime(new Date(event.endTime), intlTag, zone)}
              </span>
            </>
          )}
        </span>
        <span className="agenda__bar" style={{ background: color }} aria-hidden="true" />
        <span className="agenda__text">
          <a className="agenda__title" {...link} aria-current={selected ? "true" : undefined}>
            {event.title}
          </a>
          {meta ? <span className="agenda__meta">{meta}</span> : null}
          {conflict ? (
            <button
              type="button"
              className="conflict-chip"
              onClick={() => {
                handOffToAssistant({
                  text: t("calendar.conflict.ask", {
                    a: event.title,
                    b: conflict.with.title,
                  }),
                });
                navigate({ name: "assistant", section: "chat" });
              }}
            >
              <Icon name="alert" size={14} strokeWidth={2} />
              {t("calendar.conflict.chip", { title: conflict.with.title })}
            </button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function NowLine({ now, zone }: { now: Date; zone: string }) {
  const { t, intlTag } = useI18n();
  const time = agendaTime(now, intlTag, zone);
  return (
    <div className="now-line" role="img" aria-label={t("calendar.now", { time })}>
      <span className="now-line__time">{time}</span>
      <span className="now-line__rule" />
    </div>
  );
}

function Agenda({
  day,
  today,
  events,
  now,
  zone,
  selectedId,
  ctx,
}: {
  day: DayKey;
  today: DayKey;
  events: CalendarEventWire[];
  now: Date;
  zone: string;
  selectedId: string | undefined;
  ctx: ReturnType<typeof useSourceContext>;
}) {
  const { t, intlTag } = useI18n();
  const dayEvents = eventsOnDay(events, day, zone);
  const conflicts = conflictsOf(dayEvents);
  const line = nowLineIndex(dayEvents, day, now, zone);
  const legend = legendOf(dayEvents.length ? dayEvents : events, ctx.primaryPurpose);
  const heading =
    day === today
      ? t("calendar.todayHeading", { weekday: weekdayLong(day, intlTag) })
      : dayLong(day, intlTag);
  return (
    <section className="agenda" aria-labelledby="agenda-h">
      <div className="agenda__head">
        <h2 id="agenda-h" className="agenda__heading">
          {heading}
        </h2>
        {legend.length ? (
          <ul className="legend" aria-label={t("calendar.legend")}>
            {legend.map((s) => (
              <li key={s.key} className="legend__item" title={sourceName(s, t)}>
                <span
                  className="legend__swatch"
                  style={{ background: sourceColor(s, ctx.purposeOfSource(s.key, s.provider)) }}
                  aria-hidden="true"
                />
                {legendName(s, t)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {dayEvents.length === 0 ? (
        <EmptyState tone="neutral" icon="calendar" title={t("calendar.empty")} />
      ) : (
        <ol className="agenda__list card">
          {dayEvents.map((event, i) => (
            <AgendaRow
              key={event.id}
              event={event}
              now={now}
              zone={zone}
              conflict={conflicts.get(event.id)}
              selected={event.id === selectedId}
              showNowBefore={line === i}
              ctx={ctx}
            />
          ))}
          {line === dayEvents.length ? (
            <li className="agenda__item agenda__item--end">
              <NowLine now={now} zone={zone} />
            </li>
          ) : null}
        </ol>
      )}
    </section>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

function EventDetail({
  id,
  cached,
  events,
  now,
  zone,
  ctx,
}: {
  id: string;
  cached: CalendarEventWire | undefined;
  events: CalendarEventWire[];
  now: Date;
  zone: string;
  ctx: ReturnType<typeof useSourceContext>;
}) {
  const { t, intlTag } = useI18n();
  const { navigate } = useRouter();
  const query = useCalendarEvent(id, cached);
  const event = query.data;
  const back = (
    <button type="button" className="detail-back" onClick={() => navigate({ name: "calendar" })}>
      <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
      {t("tab.calendar")}
    </button>
  );
  if (!event) {
    return (
      <div className="screen event-detail">
        {back}
        {query.isError ? (
          isApiError(query.error) && query.error.status === 404 ? (
            <EmptyState tone="neutral" icon="calendar" title={t("calendar.detail.gone")} />
          ) : (
            <ProblemState kind="error" onRetry={() => void query.refetch()} />
          )
        ) : (
          <SkeletonRows rows={2} />
        )}
      </div>
    );
  }
  const source = sourceOf(event, ctx.primaryPurpose);
  const color = sourceColor(source, ctx.purposeOf(event));
  const service = meetingService(event.meetingLink);
  const httpsLink = (() => {
    try {
      return event.meetingLink && new URL(event.meetingLink).protocol === "https:"
        ? event.meetingLink
        : null;
    } catch {
      return null;
    }
  })();
  const day = dayKeyOf(new Date(event.startTime), zone);
  const other = overlapOf(eventsOnDay(events, day, zone), event.id);
  const conflict = other ? { with: other } : null;
  const start = new Date(event.startTime);
  const status = isPast(event, now)
    ? t("calendar.detail.ended")
    : isOngoing(event, now)
      ? t("calendar.detail.now")
      : formatRelativeFromNow(start, now, intlTag);
  const when = event.allDay
    ? `${dayLong(day, intlTag)} · ${t("calendar.allDay")}`
    : `${dayLong(day, intlTag)} · ${agendaTime(start, intlTag, zone)}–${agendaTime(new Date(event.endTime), intlTag, zone)}`;
  return (
    <article className="screen event-detail" aria-labelledby="event-h">
      {back}
      <div className="event-detail__body">
        <span className="event-detail__source">
          <span className="legend__swatch" style={{ background: color }} aria-hidden="true" />
          {sourceName(source, t)}
          {event.readOnly ? (
            <span className="event-detail__ro">· {t("calendar.detail.readOnlyShort")}</span>
          ) : null}
        </span>
        <h1 id="event-h" className="event-detail__title">
          {event.title}
        </h1>
        <p className="event-detail__when">
          {when}
          <span className="event-detail__status">{status}</span>
        </p>
        {event.location ? (
          <p className="event-detail__line">
            <Icon name="pin" size={18} />
            {event.location}
          </p>
        ) : null}
        {httpsLink ? (
          <button
            type="button"
            className="button button--primary event-detail__join"
            onClick={() => void openExternal(httpsLink)}
          >
            <Icon name="video" size={18} />
            {service ? t("calendar.detail.joinWith", { service }) : t("calendar.detail.join")}
          </button>
        ) : null}
        {conflict ? (
          <section className="event-detail__conflict">
            <span className="event-detail__conflict-title">
              <Icon name="alert" size={16} strokeWidth={2} />
              {t("calendar.detail.conflict", {
                title: conflict.with.title,
                time: `${agendaTime(new Date(conflict.with.startTime), intlTag, zone)}–${agendaTime(new Date(conflict.with.endTime), intlTag, zone)}`,
              })}
            </span>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                handOffToAssistant({
                  text: t("calendar.conflict.ask", { a: event.title, b: conflict.with.title }),
                });
                navigate({ name: "assistant", section: "chat" });
              }}
            >
              <Icon name="sparkSmall" size={16} />
              {t("calendar.conflict.cta")}
            </button>
          </section>
        ) : null}
        {event.description ? (
          <p className="event-detail__description selectable">{event.description}</p>
        ) : null}
        {event.readOnly ? (
          <p className="event-detail__note">
            <Icon name="lock" size={16} />
            {t("calendar.detail.readOnly", { source: sourceName(source, t) })}
          </p>
        ) : null}
      </div>
    </article>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export function CalendarScreen({ id }: { id?: string }) {
  const { t, intlTag } = useI18n();
  const online = useOnline();
  const now = useNow();
  const me = useMe();
  const userZone = me.data?.timezone;
  const zone = isKnownZone(userZone) ? userZone : deviceZone();
  const today = dayKeyOf(now, zone);
  const [selected, setSelected] = useState<DayKey>(today);
  const [sheet, setSheet] = useState<"new" | "team" | null>(null);
  const [teamDraft, setTeamDraft] = useState<EventDraftWire | null>(null);

  const days = useMemo(() => weekOf(selected, weekStartsOn(intlTag)), [selected, intlTag]);
  const range = useMemo(() => weekRange(days, zone), [days, zone]);
  const events = useCalendarRange(range.start, range.end);
  const teams = useTeams(me.data?.teamMode !== false);
  const ctx = useSourceContext();
  const list = events.data ?? [];
  const busy = busyDays(list, days, zone);
  const cached = id ? list.find((e) => e.id === id) : undefined;

  // A deep link to an event (Today's "View") selects that event's day once.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!id || jumped.current === id || !cached) return;
    jumped.current = id;
    setSelected(dayKeyOf(new Date(cached.startTime), zone));
  }, [id, cached, zone]);

  const offline = events.isError && isApiError(events.error) && events.error.isOffline;
  const agenda = (
    <div className="cal-pane">
      <header className="cal-head">
        <CalendarHeader
          selected={selected}
          today={today}
          onToday={() => setSelected(today)}
          teamAvailable={Array.isArray(teams.data)}
          onTeam={() => setSheet("team")}
          onNew={() => {
            setTeamDraft(null);
            setSheet("new");
          }}
        />
        <WeekStrip
          days={days}
          selected={selected}
          today={today}
          busy={busy}
          onSelect={setSelected}
          onShift={(weeks) => setSelected((d) => addDays(d, weeks * 7))}
        />
      </header>
      <div className="cal-scroll">
        {!online || (offline && events.data) ? <OfflineBanner /> : null}
        {events.data ? (
          <Agenda
            day={selected}
            today={today}
            events={list}
            now={now}
            zone={zone}
            selectedId={id}
            ctx={ctx}
          />
        ) : events.isError ? (
          <ProblemState
            kind={offline ? "offline" : "error"}
            onRetry={() => void events.refetch()}
          />
        ) : (
          <div aria-busy="true">
            <SkeletonRows rows={3} label={t("state.loading")} />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <ListDetail
        list={agenda}
        detail={
          id ? (
            <EventDetail id={id} cached={cached} events={list} now={now} zone={zone} ctx={ctx} />
          ) : null
        }
        emptyDetail={
          <div className="screen pane-empty">
            <EmptyState tone="neutral" icon="calendar" title={t("calendar.detail.pick")} />
          </div>
        }
        listLabel={t("calendar.agendaLabel")}
        detailLabel={t("calendar.detail.label")}
      />
      <NewEventSheet
        open={sheet === "new"}
        onClose={() => setSheet(null)}
        day={selected}
        zone={zone}
        now={now}
        initialDraft={teamDraft}
        onCreated={(draft) => setSelected(dayKeyOf(new Date(draft.startTime), zone))}
      />
      {Array.isArray(teams.data) ? (
        <TeamFreeSheet
          open={sheet === "team"}
          onClose={() => setSheet(null)}
          teams={teams.data}
          zone={zone}
          now={now}
          onDraft={(draft) => {
            setTeamDraft(draft);
            setSheet("new");
          }}
        />
      ) : null}
    </>
  );
}
