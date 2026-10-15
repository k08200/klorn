"use client";

// Team mode P1 on the web: saved member groups the assistant can schedule
// around ("AX팀 내일 언제 다 돼?"). Mirrors the desktop Preferences → TEAMS
// section; availability honesty (unknown ≠ free) lives server-side.

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useT } from "../lib/i18n";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";

interface Team {
  id: string;
  name: string;
  members: string[];
}

export function TeamsSection({ wrapper }: { wrapper?: (children: ReactNode) => ReactNode }) {
  const { t } = useT();
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [membersText, setMembersText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Team mode is a paid team-tier capability shipped dark; a 403
  // TEAM_REQUIRED hides the whole section rather than showing a dead form.
  const [available, setAvailable] = useState(false);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ teams: Team[] }>("/api/teams");
      setTeams(data.teams);
      setAvailable(true);
      // Today's "When is everyone free?" reads the same list from the cache.
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams.all });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("API 403")) {
        setAvailable(false);
        return;
      }
      captureClientError(err, { scope: "teams.load" });
    }
  }, [queryClient]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    setSaving(true);
    setError(null);
    const members = membersText
      .split(/[\s,]+/)
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean);
    try {
      await apiFetch("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), members }),
      });
      setName("");
      setMembersText("");
      await load();
    } catch (err) {
      captureClientError(err, { scope: "teams.create" });
      setError(t("settings.teams.failed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiFetch(`/api/teams/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      captureClientError(err, { scope: "teams.delete" });
    }
  };

  if (!available) return null;
  const body = (
    <div className="space-y-4">
      {teams.length === 0 && <p className="text-sm text-ink-dim">{t("settings.teams.empty")}</p>}
      {teams.map((team) => (
        <div key={team.id} className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{team.name}</p>
            <p className="truncate text-xs text-ink-dim">{team.members.join(", ")}</p>
          </div>
          <button
            type="button"
            onClick={() => remove(team.id)}
            className="shrink-0 text-xs text-ink-dim transition hover:text-ink"
          >
            {t("settings.teams.remove")}
          </button>
        </div>
      ))}
      <div className="space-y-2 border-t border-line/70 pt-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.teams.namePlaceholder")}
          className="w-full rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm placeholder-ink-dim transition focus:border-accent-muted focus:outline-none"
        />
        <input
          type="text"
          value={membersText}
          onChange={(e) => setMembersText(e.target.value)}
          placeholder={t("settings.teams.membersPlaceholder")}
          className="w-full rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm placeholder-ink-dim transition focus:border-accent-muted focus:outline-none"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={add}
            disabled={saving || !name.trim() || !membersText.trim()}
            className="rounded-lg bg-accent-solid px-4 py-2 text-sm font-medium text-accent-solid-ink transition hover:bg-accent-solid-hover disabled:opacity-50"
          >
            {saving ? t("settings.teams.adding") : t("settings.teams.add")}
          </button>
          {error && <p className="text-xs text-ink-dim">{error}</p>}
        </div>
        <p className="text-xs leading-relaxed text-ink-dim">{t("settings.teams.note")}</p>
      </div>
    </div>
  );
  return wrapper ? <>{wrapper(body)}</> : body;
}
