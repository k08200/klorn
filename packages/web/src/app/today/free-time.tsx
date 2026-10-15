"use client";

/**
 * Today — "When is everyone free?" (productization plan §1, P12, team mode).
 * Offered only with the server's TEAM_MODE_ENABLED on (`user.teamMode`) and a
 * saved team. It reads GET /api/teams/:id/availability — the common free slots
 * for the user and every member whose calendar is visible — and shows them.
 * It creates no event: scheduling stays in the assistant's approval flow.
 * Members whose calendars cannot be seen are named, never counted as free.
 */

import type { TeamAvailabilityResponse, TeamsListResponse } from "@klorn/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import Button from "../../components/ui/button";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { BlockError, BlockNote } from "./block";
import {
  availabilityPath,
  FREE_TIME_WINDOW_DAYS,
  formatSlot,
  freeTimeScope,
  freeTimeStale,
  freeTimeVisible,
  upcomingSlots,
} from "./free-time-model";

const TEAMS_STALE_MS = 5 * 60_000;
const DEFAULT_TIME_ZONE = "Asia/Seoul";
/** How often a shown result re-checks the clock, so past slots drop off. */
const CLOCK_TICK_MS = 60_000;

/** The current time, re-read every CLOCK_TICK_MS while `active`. */
function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function useTeams(enabled: boolean) {
  const query = useQuery({
    queryKey: queryKeys.teams.list(),
    queryFn: () => apiFetch<TeamsListResponse>("/api/teams"),
    staleTime: TEAMS_STALE_MS,
    enabled,
  });
  return query.data?.teams ?? [];
}

export function FreeTimeRow() {
  const { user } = useAuth();
  const teams = useTeams(user?.teamMode === true);
  if (!freeTimeVisible(user, teams)) return null;
  return <FreeTimeFinder teams={teams} />;
}

function FreeTimeFinder({ teams }: { teams: TeamsListResponse["teams"] }) {
  const { t, locale } = useT();
  const { user } = useAuth();
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const selected = teams.some((team) => team.id === teamId) ? teamId : (teams[0]?.id ?? "");
  // The last answer stays on screen while "Check again" runs: a new mutate()
  // clears the mutation's own data, which would unmount the button in use.
  const [shown, setShown] = useState<{
    result: TeamAvailabilityResponse;
    fetchedAtMs: number;
  } | null>(null);
  const find = useMutation({
    onSuccess: (result) => setShown({ result, fetchedAtMs: Date.now() }),
    mutationFn: async (id: string) => {
      try {
        return await apiFetch<TeamAvailabilityResponse>(availabilityPath(id, new Date()));
      } catch (err) {
        captureClientError(err, { scope: "today.freeTime" });
        throw err;
      }
    },
  });
  const run = () => {
    if (selected) find.mutate(selected);
  };
  const timeZone = shown?.result.timeZone ?? user?.timezone ?? DEFAULT_TIME_ZONE;
  const now = useNow(shown !== null);

  return (
    <div className="flex flex-col gap-2 border-t border-line-soft py-3">
      <h3 className="text-caption font-medium text-ink-muted">{t("today.freeTime.title")}</h3>
      <div className="flex flex-wrap items-center gap-2">
        {teams.length > 1 && (
          <>
            <label htmlFor="today-free-team" className="sr-only">
              {t("today.freeTime.team")}
            </label>
            <select
              id="today-free-team"
              value={selected}
              onChange={(event) => {
                setTeamId(event.target.value);
                find.reset();
                setShown(null);
              }}
              className="focus-ring h-11 min-w-0 flex-1 rounded-control border border-line bg-surface-panel px-3 text-body text-ink"
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </>
        )}
        <Button variant="secondary" onClick={run} disabled={find.isPending || !selected}>
          {find.isPending ? t("today.freeTime.finding") : t("today.freeTime.find")}
        </Button>
      </div>
      <div aria-live="polite">
        {find.isError && <BlockError message={t("today.freeTime.error")} onRetry={run} />}
        {shown && (
          <FreeTimeResult
            result={shown.result}
            locale={locale}
            timeZone={timeZone}
            now={now}
            fetchedAtMs={shown.fetchedAtMs}
            onRecheck={run}
            rechecking={find.isPending}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The slots, after the notice about whose calendars were not seen. With no
 * member checked at all, the slots are only the user's own and say so. A slot
 * that has started is not shown; an old result offers "Check again".
 */
function FreeTimeResult({
  result,
  locale,
  timeZone,
  now,
  fetchedAtMs,
  onRecheck,
  rechecking,
}: {
  result: TeamAvailabilityResponse;
  locale: string;
  timeZone: string;
  now: Date;
  fetchedAtMs: number;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const { t } = useT();
  const selfOnly = freeTimeScope(result) === "self-only";
  const slots = upcomingSlots(result.slots, now);
  const stale = freeTimeStale(fetchedAtMs, result.slots, now);
  return (
    <>
      {selfOnly ? (
        <p className="pt-1 text-caption text-ink-muted [word-break:keep-all]">
          {t("today.freeTime.selfOnly")}
        </p>
      ) : (
        result.unknownMembers.length > 0 && (
          <p className="pt-1 text-caption text-ink-muted [word-break:keep-all]">
            {t("today.freeTime.unknown", { members: result.unknownMembers.join(", ") })}
          </p>
        )
      )}
      {stale && (
        <div className="flex flex-wrap items-center gap-x-3 pt-1">
          <p className="min-w-0 flex-1 py-2 text-caption text-ink-muted [word-break:keep-all]">
            {t("today.freeTime.stale")}
          </p>
          <Button variant="secondary" size="sm" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? t("today.freeTime.finding") : t("today.freeTime.recheck")}
          </Button>
        </div>
      )}
      {/* Every slot already past: "Check again" says it better than "none". */}
      {result.slots.length === 0 && (
        <BlockNote>{t("today.freeTime.none", { days: String(FREE_TIME_WINDOW_DAYS) })}</BlockNote>
      )}
      {slots.length > 0 && (
        <ul
          aria-label={selfOnly ? t("today.freeTime.selfOnlyList") : t("today.freeTime.teamList")}
          className="flex flex-col gap-1 pt-1"
        >
          {slots.map((slot) => (
            <li key={slot.startTime} className="text-body tabular-nums text-ink-strong">
              {formatSlot(slot, locale, timeZone)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
