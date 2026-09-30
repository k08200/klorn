/**
 * Agent activity for one read-write key (step A3): a disclosure button and the
 * panel it opens. The panel loads GET /api/keys/:id/activity when it opens —
 * nothing is fetched for a collapsed key — and lists what an agent did through
 * the key: when, what, and how it ended. No animation: the panel appears and
 * disappears, so reduced-motion needs no special case. The opaque message id and
 * every hash stay out of the UI.
 */

import type { ApiKeyActivityResponse, ApiKeyActivityWire } from "@klorn/contract";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import {
  formatActivityTime,
  type KeyedActivity,
  keyActivityRows,
  outcomeChipClasses,
  outcomeLabelKey,
  reasonLabelKey,
  toolLabelKey,
} from "../lib/api-key-ui";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";

const TOGGLE =
  "ease-strong inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-ink-mid transition duration-150 hover:text-ink motion-reduce:transition-none focus-ring";
const STATUS_TEXT = "text-xs text-ink-mid";

interface ToggleProps {
  keyName: string;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}

export function ApiKeyActivityToggle({ keyName, open, panelId, onToggle }: ToggleProps) {
  const { t } = useT();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={t("settings.apiKeys.activity.toggleFor", { name: keyName })}
      onClick={onToggle}
      className={TOGGLE}
    >
      <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      {t("settings.apiKeys.activity.toggle")}
    </button>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; rows: KeyedActivity[] };

function useKeyActivity(keyId: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    apiFetch<ApiKeyActivityResponse>(`/api/keys/${encodeURIComponent(keyId)}/activity`)
      .then((body) => {
        if (!cancelled) setState({ status: "ready", rows: keyActivityRows(body.activity) });
      })
      .catch((err) => {
        captureClientError(err, { scope: "settings.api-keys-activity" });
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [keyId]);

  return state;
}

function ActivityRow({
  row,
  formatter,
}: {
  row: ApiKeyActivityWire;
  formatter: Intl.DateTimeFormat;
}) {
  const { t } = useT();
  const toolKey = toolLabelKey(row.tool);
  const reasonKey = reasonLabelKey(row.reason);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
      <time dateTime={row.createdAt} className="tabular-nums text-ink-mid">
        {formatActivityTime(row.createdAt, formatter)}
      </time>
      <span className="text-ink">{toolKey ? t(toolKey) : row.tool}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${outcomeChipClasses(row.outcome)}`}
      >
        {t(outcomeLabelKey(row.outcome))}
      </span>
      {reasonKey && <span className="text-ink-mid">{t(reasonKey)}</span>}
    </li>
  );
}

export function ApiKeyActivityPanel({ id, keyId }: { id: string; keyId: string }) {
  const { t, locale } = useT();
  const state = useKeyActivity(keyId);
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  return (
    <div id={id} className="w-full rounded-xl border border-line bg-surface-raised px-3 py-1">
      {state.status === "loading" && (
        <p role="status" className={`${STATUS_TEXT} py-2`}>
          {t("settings.apiKeys.activity.loading")}
        </p>
      )}
      {state.status === "error" && (
        <p role="status" className={`${STATUS_TEXT} py-2`}>
          {t("settings.apiKeys.activity.loadFailed")}
        </p>
      )}
      {state.status === "ready" && state.rows.length === 0 && (
        <p role="status" className={`${STATUS_TEXT} py-2`}>
          {t("settings.apiKeys.activity.empty")}
        </p>
      )}
      {state.status === "ready" && state.rows.length > 0 && (
        <ul className="divide-y divide-line-soft">
          {state.rows.map(({ key, row }) => (
            <ActivityRow key={key} row={row} formatter={formatter} />
          ))}
        </ul>
      )}
    </div>
  );
}
