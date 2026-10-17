"use client";

/**
 * Subscriptions (Mail → Subscriptions): the senders that mail the user through a
 * list, one row per sender and connected account, with an "Unsubscribe" and an
 * "Unsubscribe and archive" action on each. Nothing runs until the user clicks;
 * a sender's own unsubscribe page opens only from a link the user follows.
 *
 * Behind BULK_UNSUBSCRIBE_ENABLED on the server: while it is off the list
 * answers 404 and this page shows only a calm "not available" state.
 */

import type {
  EmailSubscriptionUnsubscribeResponse,
  EmailSubscriptionWire,
  EmailUnsubscribeMethod,
} from "@klorn/contract";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useConfirm } from "../../../components/confirm-dialog";
import Button from "../../../components/ui/button";
import EmptyState from "../../../components/ui/empty-state";
import ErrorAlert from "../../../components/ui/error-alert";
import LoadingState from "../../../components/ui/loading-state";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import { formatRelativeIntl } from "../../../lib/text";
import { useMailSubscriptions } from "../../../lib/use-mail-subscriptions";

const METHOD_KEYS: Record<EmailUnsubscribeMethod, string> = {
  "one-click": "mailSubscriptions.method.oneClick",
  mailto: "mailSubscriptions.method.mailto",
  link: "mailSubscriptions.method.link",
};

type RowState =
  | { kind: "pending"; archive: boolean }
  | { kind: "done"; archived: number; archiveFailed: number }
  | { kind: "link"; url: string; archived: number; archiveFailed: number }
  | { kind: "error" };

const rowKey = (row: Pick<EmailSubscriptionWire, "sender" | "linkedInboxAccountId">) =>
  `${row.linkedInboxAccountId ?? "primary"}:${row.sender}`;

/** Only a plain web page is ever offered as a link. */
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

export default function SubscriptionsPage() {
  return (
    <AuthGuard>
      <SubscriptionsView />
    </AuthGuard>
  );
}

function SubscriptionsView() {
  const { t } = useT();
  const { confirm } = useConfirm();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useMailSubscriptions();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [announcement, setAnnouncement] = useState("");

  const nameOf = (row: EmailSubscriptionWire) => row.displayName ?? row.sender;
  const accountOf = (row: EmailSubscriptionWire) =>
    row.accountLabel ?? t("mailSubscriptions.account.primary");

  const run = async (row: EmailSubscriptionWire, archive: boolean) => {
    const key = rowKey(row);
    if (rows[key]?.kind === "pending") return;
    if (archive) {
      const ok = await confirm({
        title: t("mailSubscriptions.confirm.title"),
        message: t("mailSubscriptions.confirm.message", {
          sender: nameOf(row),
          account: accountOf(row),
        }),
        confirmLabel: t("mailSubscriptions.action.unsubscribeArchive"),
        dismissLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    setRows((prev) => ({ ...prev, [key]: { kind: "pending", archive } }));
    setAnnouncement(t("mailSubscriptions.status.pending", { sender: nameOf(row) }));
    try {
      const res = await apiFetch<EmailSubscriptionUnsubscribeResponse>(
        "/api/email/subscriptions/unsubscribe",
        {
          method: "POST",
          body: JSON.stringify({
            sender: row.sender,
            linkedInboxAccountId: row.linkedInboxAccountId,
            archive,
          }),
        },
      );
      const counts = { archived: res.archived, archiveFailed: res.archiveFailed };
      if (res.done) {
        setRows((prev) => ({ ...prev, [key]: { kind: "done", ...counts } }));
        setAnnouncement(t("mailSubscriptions.status.done", { sender: nameOf(row) }));
      } else if (isWebUrl(res.url)) {
        setRows((prev) => ({ ...prev, [key]: { kind: "link", url: res.url, ...counts } }));
        setAnnouncement(t("mailSubscriptions.status.link", { sender: nameOf(row) }));
      } else {
        setRows((prev) => ({ ...prev, [key]: { kind: "error" } }));
        setAnnouncement(t("mailSubscriptions.status.error", { sender: nameOf(row) }));
      }
      if (res.archived > 0) {
        // Archived mail left the list views; the Subscriptions list itself is
        // left alone so the row the user just acted on stays where it was.
        void queryClient.invalidateQueries({ queryKey: ["email", "list"] });
      }
    } catch (err) {
      captureClientError(err, { scope: "email.subscriptions.unsubscribe" });
      setRows((prev) => ({ ...prev, [key]: { kind: "error" } }));
      setAnnouncement(t("mailSubscriptions.status.error", { sender: nameOf(row) }));
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-28 pt-6 md:py-10">
      <Link
        href="/email"
        className="focus-ring inline-flex min-h-11 items-center rounded-control text-label text-ink-mid hover:text-ink"
      >
        {t("mailSubscriptions.back")}
      </Link>
      <header className="mb-6 mt-2">
        <h1 className="text-display text-ink">{t("mailSubscriptions.title")}</h1>
        {data && (
          <p className="mt-2 max-w-2xl text-body text-ink-muted [word-break:keep-all]">
            {t("mailSubscriptions.description", { days: String(data.windowDays) })}
          </p>
        )}
      </header>

      {/* One polite region for every row's outcome, so each result is read once. */}
      <p aria-live="polite" role="status" className="sr-only">
        {announcement}
      </p>

      {isLoading ? (
        <LoadingState rows={4} rowHeight="h-24" label={t("mailSubscriptions.loading")} />
      ) : isError ? (
        <ErrorAlert title={t("mailSubscriptions.error.title")} onRetry={() => void refetch()}>
          {t("mailSubscriptions.error.load")}
        </ErrorAlert>
      ) : data === null || data === undefined ? (
        <EmptyState
          headingLevel="h2"
          title={t("mailSubscriptions.unavailable.title")}
          description={t("mailSubscriptions.unavailable.body")}
        />
      ) : data.subscriptions.length === 0 ? (
        <EmptyState
          headingLevel="h2"
          title={t("mailSubscriptions.empty.title")}
          description={t("mailSubscriptions.empty.body")}
        />
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface-panel">
          {data.subscriptions.map((row) => (
            <SubscriptionRow
              key={rowKey(row)}
              row={row}
              name={nameOf(row)}
              account={accountOf(row)}
              state={rows[rowKey(row)]}
              onUnsubscribe={(archive) => void run(row, archive)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubscriptionRow({
  row,
  name,
  account,
  state,
  onUnsubscribe,
}: {
  row: EmailSubscriptionWire;
  name: string;
  account: string;
  state: RowState | undefined;
  onUnsubscribe: (archive: boolean) => void;
}) {
  const { t, locale } = useT();
  const nameId = useId();
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const pendingArchive = state?.kind === "pending" ? state.archive : null;
  const finished = state?.kind === "done" || state?.kind === "link";
  const readRate = row.count > 0 ? (row.count - row.unreadCount) / row.count : 0;
  const lastReceived = formatRelativeIntl(
    row.lastReceivedAt,
    locale,
    t("mailSubscriptions.justNow"),
  );
  return (
    <li className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <p id={nameId} className="truncate text-head text-ink">
          {name}
        </p>
        <p className="truncate text-caption text-ink-muted">
          {row.displayName ? `${row.sender} · ` : ""}
          {account}
        </p>
        <p className="mt-1 text-caption text-ink-mid tabular-nums">
          {t("mailSubscriptions.stats.count", { count: number.format(row.count) })}
          {" · "}
          {t("mailSubscriptions.stats.readRate", { rate: percent.format(readRate) })}
          {" · "}
          {t("mailSubscriptions.stats.last", { when: lastReceived })}
          {" · "}
          {t(METHOD_KEYS[row.method])}
        </p>
        <RowOutcome state={state} />
      </div>
      {!finished && (
        // The visible label stays the accessible name (WCAG 2.5.3); the sender
        // it acts on is announced as the description.
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={pendingArchive === false}
            disabled={pendingArchive !== null}
            onClick={() => onUnsubscribe(false)}
            aria-describedby={nameId}
          >
            {t("mailSubscriptions.action.unsubscribe")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={pendingArchive === true}
            disabled={pendingArchive !== null}
            onClick={() => onUnsubscribe(true)}
            aria-describedby={nameId}
          >
            {t("mailSubscriptions.action.unsubscribeArchive")}
          </Button>
        </div>
      )}
    </li>
  );
}

function RowOutcome({ state }: { state: RowState | undefined }) {
  const { t } = useT();
  if (!state || state.kind === "pending") return null;
  if (state.kind === "error") {
    return (
      <p className="mt-2 text-label text-state-danger-ink">{t("mailSubscriptions.row.error")}</p>
    );
  }
  const archivedNote =
    state.archived > 0 || state.archiveFailed > 0 ? (
      <span className="block text-caption text-ink-mid">
        {state.archiveFailed > 0
          ? t("mailSubscriptions.row.archivedSome", {
              count: String(state.archived),
              failed: String(state.archiveFailed),
            })
          : t("mailSubscriptions.row.archived", { count: String(state.archived) })}
      </span>
    ) : null;
  if (state.kind === "done") {
    return (
      <p className="mt-2 text-label text-state-ok-ink">
        {t("mailSubscriptions.row.done")}
        {archivedNote}
      </p>
    );
  }
  return (
    <div className="mt-2 text-label text-ink">
      <p>{t("mailSubscriptions.row.linkHint")}</p>
      <a
        href={state.url}
        target="_blank"
        rel="noopener noreferrer"
        className="focus-ring mt-1 inline-flex min-h-11 items-center rounded-control text-accent-deep underline underline-offset-2 hover:text-ink"
      >
        {t("mailSubscriptions.row.openLink")}
        <span className="sr-only"> {t("mailSubscriptions.row.newTab")}</span>
      </a>
      {archivedNote}
    </div>
  );
}
