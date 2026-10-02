/**
 * Agent activity for one read-write key (step A3): a disclosure button and the
 * panel it opens. The panel loads GET /api/keys/:id/activity when it opens —
 * nothing is fetched for a collapsed key — and lists what an agent did through
 * the key: when, what, and how it ended. No animation: the panel appears and
 * disappears, so reduced-motion needs no special case. The opaque message id and
 * every hash stay out of the UI.
 */

import type { ApiKeyActivityResponse, ApiKeyActivityWire } from "@klorn/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import {
  formatActivityTime,
  KEY_ACTIVITY_LIMIT,
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
const RETRY =
  "ease-strong inline-flex min-h-11 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink transition duration-150 hover:bg-surface-panel motion-reduce:transition-none focus-ring";
const STATUS_TEXT = "py-2 text-xs text-ink-mid";

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

/** apiFetch throws `API <status>: <body>`; this is the repo's way to read a 404 off it. */
const isNotFound = (err: unknown) => err instanceof Error && err.message.startsWith("API 404");

/**
 * Loads the key's activity on mount and again on `retry`. The request is
 * aborted on unmount, and an aborted request is neither an error state nor a
 * Sentry event. A 404 means the server has write tools switched off (the route
 * is dark then), which reads as "no activity", not as a failure.
 */
function useKeyActivity(keyId: string): { state: LoadState; retry: () => void } {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    apiFetch<ApiKeyActivityResponse>(`/api/keys/${encodeURIComponent(keyId)}/activity`, {
      signal: controller.signal,
    })
      .then((body) => {
        if (controller.signal.aborted) return;
        setState({ status: "ready", rows: keyActivityRows(body.activity) });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (isNotFound(err)) {
          setState({ status: "ready", rows: [] });
          return;
        }
        captureClientError(err, { scope: "settings.api-keys-activity" });
        setState({ status: "error" });
      });
  }, [keyId]);

  useEffect(() => {
    load();
    return () => inFlight.current?.abort();
  }, [load]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    load();
  }, [load]);

  return { state, retry };
}

function ActivityRow({
  row,
  formatter,
}: {
  row: ApiKeyActivityWire;
  formatter: Intl.DateTimeFormat;
}) {
  const { t } = useT();
  const reasonKey = reasonLabelKey(row.reason);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs">
      <time dateTime={row.createdAt} className="tabular-nums text-ink-mid">
        {formatActivityTime(row.createdAt, formatter)}
      </time>
      <span className="text-ink">{t(toolLabelKey(row.tool))}</span>
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
  const { state, retry } = useKeyActivity(keyId);
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const rows = state.status === "ready" ? state.rows : [];

  return (
    <div id={id} className="w-full rounded-xl border border-line bg-surface-raised px-3 py-1">
      {/* One status region for the panel's whole life, so a screen reader hears
          "loading", then the result. Only short messages live in it: announcing
          a 50-row list would be noise. */}
      <div role="status" aria-busy={state.status === "loading"}>
        {state.status === "loading" && (
          <p className={STATUS_TEXT}>{t("settings.apiKeys.activity.loading")}</p>
        )}
        {state.status === "ready" && rows.length === 0 && (
          <p className={STATUS_TEXT}>{t("settings.apiKeys.activity.empty")}</p>
        )}
      </div>
      {state.status === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 py-1">
          <p className="text-xs text-ink-mid">{t("settings.apiKeys.activity.loadFailed")}</p>
          <button type="button" onClick={retry} className={RETRY}>
            {t("settings.apiKeys.activity.retry")}
          </button>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-line-soft">
          {rows.map(({ key, row }) => (
            <ActivityRow key={key} row={row} formatter={formatter} />
          ))}
        </ul>
      )}
      {rows.length >= KEY_ACTIVITY_LIMIT && (
        <p className={STATUS_TEXT}>
          {t("settings.apiKeys.activity.limitNote", { count: String(KEY_ACTIVITY_LIMIT) })}
        </p>
      )}
    </div>
  );
}
