"use client";

import Link from "next/link";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import Button from "../ui/button";
import {
  buildMonthCells,
  type CalendarEvent,
  formatTime,
  type MonthCell,
  monthIndexInZone,
  weekdayNames,
} from "./month-utils";

/**
 * Touch / narrow month view (founder decision, option A).
 *
 * The desktop grid puts ~20px event links inside each day cell, which fails
 * the 44px touch-target rule, and 44px links would overflow the cells. Here a
 * day is one ≥44×44 button (date + up to two dots); the selected day's events
 * list below the grid as ≥52px rows that open the event detail.
 *
 * Keyboard: the grid is one tab stop (roving tabindex). Arrow keys move focus
 * within the month; Enter / Space selects (the native button click).
 */

const MAX_DOTS = 2;
const DOT_KEYS = ["first", "second"] as const;
const DAYS_PER_WEEK = 7;

interface CompactMonthProps {
  viewMonth: Date;
  monthLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  eventsByDay: Map<string, CalendarEvent[]>;
  todayKey: string;
  timeZone: string;
}

/** Weeks of the 6×7 grid that hold at least one day of the viewed month. */
function monthWeeks(cells: MonthCell[], monthIdx: number): MonthCell[][] {
  const weeks: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += DAYS_PER_WEEK) {
    const week = cells.slice(i, i + DAYS_PER_WEEK);
    if (week.some((c) => c.monthIndex === monthIdx)) weeks.push(week);
  }
  return weeks;
}

/** Long date label for a YYYY-MM-DD key, anchored at noon UTC so it never slips a day. */
function dayLabelFor(key: string, locale: string, timeZone: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
}

const ARROW_STEP: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -DAYS_PER_WEEK,
  ArrowDown: DAYS_PER_WEEK,
};

export function CompactMonth({
  viewMonth,
  monthLabel,
  onPrev,
  onNext,
  onToday,
  eventsByDay,
  todayKey,
  timeZone,
}: CompactMonthProps) {
  const { t, locale } = useT();
  const monthIdx = monthIndexInZone(viewMonth, timeZone);
  const cells = buildMonthCells(viewMonth, timeZone);
  const weeks = monthWeeks(cells, monthIdx);
  const monthDays = cells.filter((c) => c.monthIndex === monthIdx);
  const defaultKey = monthDays.some((c) => c.key === todayKey) ? todayKey : monthDays[0].key;

  // Reset to the default day whenever the viewed month changes.
  const [selection, setSelection] = useState({ month: monthDays[0].key, key: defaultKey });
  const selectedKey = selection.month === monthDays[0].key ? selection.key : defaultKey;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const tabStopKey = focusKey && monthDays.some((c) => c.key === focusKey) ? focusKey : selectedKey;

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current || !focusKey) return;
    moveFocus.current = false;
    buttons.current.get(focusKey)?.focus();
  }, [focusKey]);

  const select = (key: string) => {
    setSelection({ month: monthDays[0].key, key });
    setFocusKey(key);
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const from = monthDays.findIndex((c) => c.key === tabStopKey);
    const to = Math.min(monthDays.length - 1, Math.max(0, from + step));
    moveFocus.current = true;
    setFocusKey(monthDays[to].key);
  };

  const selectedEvents = eventsByDay.get(selectedKey) ?? [];
  const selectedLabel = dayLabelFor(selectedKey, locale, timeZone);

  return (
    <div className="space-y-4">
      <div className="panel-elevated overflow-hidden rounded-card border border-line/70 bg-surface-panel">
        <div className="flex items-center justify-between gap-2 border-b border-line-soft px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={onPrev}
              aria-label={t("calendar.prevMonth")}
            >
              ‹
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onNext}
              aria-label={t("calendar.nextMonth")}
            >
              ›
            </Button>
            <h2 className="ml-1 truncate text-role-head text-ink">{monthLabel}</h2>
          </div>
          <Button variant="secondary" size="sm" onClick={onToday}>
            {t("nav.v2.today")}
          </Button>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: an ARIA grid of day buttons has no native element. */}
        <div role="grid" aria-label={monthLabel} className="p-1.5" onKeyDown={onGridKeyDown}>
          {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid row. */}
          {/* biome-ignore lint/a11y/useFocusableInteractive: rows are not focus targets; the day buttons are. */}
          <div role="row" className="grid grid-cols-7">
            {weekdayNames(locale).map((d) => (
              // biome-ignore lint/a11y/useSemanticElements: ARIA grid column header.
              // biome-ignore lint/a11y/useFocusableInteractive: headers are not focus targets.
              <div
                key={d}
                role="columnheader"
                className="py-1 text-center text-role-caption font-medium text-ink-dim"
              >
                {d}
              </div>
            ))}
          </div>
          {weeks.map((week) => (
            // biome-ignore lint/a11y/useSemanticElements: ARIA grid row.
            // biome-ignore lint/a11y/useFocusableInteractive: rows are not focus targets.
            <div key={week[0].key} role="row" className="grid grid-cols-7">
              {week.map((cell) =>
                cell.monthIndex === monthIdx ? (
                  <DayButton
                    key={cell.key}
                    cell={cell}
                    count={(eventsByDay.get(cell.key) ?? []).length}
                    label={dayLabelFor(cell.key, locale, timeZone)}
                    selected={cell.key === selectedKey}
                    isToday={cell.key === todayKey}
                    tabbable={cell.key === tabStopKey}
                    onSelect={() => select(cell.key)}
                    onFocus={() => setFocusKey(cell.key)}
                    buttonRef={(el) => {
                      if (el) buttons.current.set(cell.key, el);
                      else buttons.current.delete(cell.key);
                    }}
                  />
                ) : (
                  // biome-ignore lint/a11y/useSemanticElements: empty ARIA grid cell.
                  // biome-ignore lint/a11y/useFocusableInteractive: padding days are not focus targets.
                  <div key={cell.key} role="gridcell" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <DayAgenda
        label={selectedLabel}
        events={selectedEvents}
        isToday={selectedKey === todayKey}
        timeZone={timeZone}
      />
    </div>
  );
}

function DayButton({
  cell,
  count,
  label,
  selected,
  isToday,
  tabbable,
  onSelect,
  onFocus,
  buttonRef,
}: {
  cell: MonthCell;
  count: number;
  label: string;
  selected: boolean;
  isToday: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onFocus: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const { t } = useT();
  const name =
    count === 0
      ? t("calendar.day.summaryNone", { date: label })
      : count === 1
        ? t("calendar.day.summaryOne", { date: label })
        : t("calendar.day.summaryMany", { date: label, count: String(count) });
  const tone = selected
    ? "bg-accent-solid text-accent-solid-ink font-semibold"
    : isToday
      ? "text-accent-deep font-semibold ring-1 ring-inset ring-accent-solid hover:bg-surface-hover"
      : "text-ink hover:bg-surface-hover";
  const dot = selected ? "bg-accent-solid-ink" : "bg-accent-solid";
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid cell holding the day button.
    // biome-ignore lint/a11y/useFocusableInteractive: the inner button is the focus target.
    <div role="gridcell" aria-selected={selected} className="flex justify-center p-0.5">
      <button
        ref={buttonRef}
        type="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={name}
        aria-current={isToday ? "date" : undefined}
        onClick={onSelect}
        onFocus={onFocus}
        className={`focus-ring flex h-12 w-full min-w-11 flex-col items-center justify-center gap-1 rounded-control transition-colors duration-120 ${tone}`}
      >
        <span className="text-role-label tabular-nums">{cell.dayNumber}</span>
        <span aria-hidden="true" className="flex h-1.5 items-center gap-0.5">
          {DOT_KEYS.slice(0, Math.min(count, MAX_DOTS)).map((k) => (
            <span key={k} className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          ))}
          {count > MAX_DOTS && <span className="text-role-caption leading-none">+</span>}
        </span>
      </button>
    </div>
  );
}

function DayAgenda({
  label,
  events,
  isToday,
  timeZone,
}: {
  label: string;
  events: CalendarEvent[];
  isToday: boolean;
  timeZone: string;
}) {
  const { t, locale } = useT();
  return (
    <section aria-label={t("calendar.day.agenda", { date: label })}>
      <div className="mb-1.5 flex items-center gap-2 px-0.5">
        <h3 className="text-role-label font-semibold text-ink-mid">{label}</h3>
        {isToday && (
          <span className="rounded-chip bg-accent/10 px-1.5 py-0.5 text-role-caption font-semibold text-accent-deep ring-1 ring-inset ring-accent/20">
            {t("nav.v2.today")}
          </span>
        )}
      </div>
      {events.length === 0 ? (
        <p className="panel-elevated rounded-card border border-line/70 bg-surface-panel px-4 py-6 text-center text-role-body text-ink-dim">
          {t("calendar.day.empty")}
        </p>
      ) : (
        <ul className="panel-elevated divide-y divide-line-soft overflow-hidden rounded-card border border-line/70 bg-surface-panel">
          {events.map((ev) => (
            <li key={ev.id} className="row-wash">
              <Link
                href={`/calendar/${ev.id}`}
                className="focus-ring flex min-h-13 flex-col justify-center gap-0.5 px-4 py-2"
              >
                <span className="truncate text-role-body font-medium text-ink">
                  {ev.title || t("common.untitled")}
                </span>
                <span className="text-role-caption tabular-nums text-ink-mid">
                  {ev.allDay
                    ? t("calendar.allDay")
                    : `${formatTime(new Date(ev.startTime), timeZone, locale)}–${formatTime(new Date(ev.endTime), timeZone, locale)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
