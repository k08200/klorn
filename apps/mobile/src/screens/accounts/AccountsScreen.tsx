/**
 * Accounts & sources (Accounts artboard): every connected mail account
 * ("inbox"), linked calendar and drive, plus this device's calendar. Each
 * row says how it is connected (Outlook, Naver and iCloud are beta); tapping
 * one shows it with "Disconnect" behind a confirmation. "Add an account"
 * offers only the providers this deployment has (a 404 hides one): Gmail and
 * Outlook through the system browser, Naver / iCloud / other IMAP with an app
 * password form. App language, appearance and sign-out live in Settings.
 */
import type { InboxOption } from "@klorn/contract";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useInboxes, useMe } from "../../api/queries";
import {
  useDriveLimits,
  useGoogleDriveAccounts,
  useImapStatus,
  useLinkedCalendars,
  useOutlookAvailable,
} from "../../api/queries-hub";
import { getServices } from "../../app/services";
import { useI18n } from "../../i18n/I18nProvider";
import { useLinkProps } from "../../router/Router";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { SourceBadge } from "../../ui/SourceBadge";
import { ProblemState, SkeletonRows } from "../../ui/StateView";
import { notify } from "../../ui/StatusNote";
import { formatSize } from "../files/model";
import { AddAccountSheet } from "./AddAccountSheet";
import {
  type AccountStatus,
  connectedInboxes,
  disconnectOf,
  providerTitleKey,
  statusOf,
} from "./model";
import "./accounts.css";

type Selected =
  | { kind: "inbox"; inbox: InboxOption }
  | {
      kind: "calendar";
      source: "google" | "outlook" | "caldav";
      id: string;
      name: string;
      email: string;
    }
  | { kind: "drive"; id: string; email: string }
  | { kind: "device" };

function StatusMark({ status, label }: { status: AccountStatus | "add" | "ask"; label: string }) {
  return (
    <span className={`acc-status acc-status--${status}`}>
      <span className="acc-status__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function Row({
  tile,
  name,
  sub,
  status,
  onClick,
}: {
  tile: ReactNode;
  name: string;
  sub: string;
  status: ReactNode;
  onClick: () => void;
}) {
  return (
    <li className="acc-row">
      <button type="button" className="acc-row__button" onClick={onClick}>
        {tile}
        <span className="acc-row__text">
          <span className="acc-row__name">{name}</span>
          <span className="acc-row__sub">{sub}</span>
        </span>
        {status}
        <Icon name="chevronRight" size={14} strokeWidth={2.2} className="acc-row__chevron" />
      </button>
    </li>
  );
}

function LetterTile({ letter, tone }: { letter: string; tone: string }) {
  return (
    <span className={`acc-tile acc-tile--${tone}`} aria-hidden="true">
      {letter}
    </span>
  );
}

export function AccountsScreen() {
  const { t, intlTag } = useI18n();
  const queryClient = useQueryClient();
  const me = useMe();
  const inboxes = useInboxes();
  const outlook = useOutlookAvailable();
  const naver = useImapStatus("naver");
  const icloud = useImapStatus("icloud");
  const generic = useImapStatus("generic");
  const googleCalendars = useLinkedCalendars("google");
  const outlookCalendars = useLinkedCalendars("outlook");
  const caldav = useLinkedCalendars("caldav");
  const limits = useDriveLimits();
  const googleDrive = useGoogleDriveAccounts();
  const settings = useLinkProps({ name: "settings" });
  const [selected, setSelected] = useState<Selected | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  const mail = connectedInboxes(inboxes.data?.inboxes ?? [], me.data?.googleConnected);
  const allCalendars = [
    ...(googleCalendars.data ?? []).map((c) => ({
      ...c,
      source: "google" as const,
      provider: "GOOGLE",
    })),
    ...(outlookCalendars.data ?? []).map((c) => ({
      ...c,
      source: "outlook" as const,
      provider: "OUTLOOK",
    })),
    ...(caldav.data ?? []).map((c) => ({
      ...c,
      source: "caldav" as const,
      provider: c.provider ?? "ICLOUD",
    })),
  ];
  // A calendar of an account that is already listed belongs to that row (its sheet
  // can disconnect it); only calendars of other accounts get rows of their own.
  const inboxEmails = new Set(mail.map((i) => i.email?.toLowerCase()).filter(Boolean));
  const calendarOf = (email: string | null | undefined) =>
    allCalendars.find((c) => email && c.email.toLowerCase() === email.toLowerCase());
  const calendars = allCalendars.filter((c) => !inboxEmails.has(c.email.toLowerCase()));

  const statusLabel = (s: AccountStatus) =>
    t(
      s === "beta"
        ? "accounts.status.beta"
        : s === "reconnect"
          ? "accounts.status.reconnect"
          : "accounts.status.connected",
    );

  const close = () => {
    setSelected(null);
    setConfirming(false);
  };

  const disconnect = async () => {
    if (!selected) return;
    setWorking(true);
    const { ep } = getServices();
    try {
      if (selected.kind === "inbox") {
        const how = disconnectOf(selected.inbox);
        if (how.kind === "primaryGoogle") await ep.accounts.disconnectPrimaryGoogle();
        else if (how.kind === "linkedGoogle") await ep.accounts.unlinkGoogleInbox(how.id);
        else if (how.kind === "outlook") await ep.accounts.unlinkOutlookInbox(how.id);
        else if (how.kind === "imap") await ep.accounts.imapDisconnect(how.imap, how.email);
      } else if (selected.kind === "calendar") {
        await ep.accounts.unlinkCalendar(selected.source, selected.id);
      } else if (selected.kind === "drive") {
        await ep.files.unlinkGoogle(selected.id);
      }
      notify(t("accounts.disconnected"));
      close();
      await Promise.all(
        [["mail"], ["accounts"], ["calendar"], ["files"], ["auth", "me"]].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    } catch {
      notify(t("accounts.disconnectFailed"), "error");
    } finally {
      setWorking(false);
    }
  };

  const detail = (() => {
    if (!selected) return null;
    if (selected.kind === "inbox") {
      const inbox = selected.inbox;
      const status = statusOf(inbox);
      const linkedCalendar = calendarOf(inbox.email);
      return {
        title: t(providerTitleKey(inbox)),
        subtitle: inbox.email ?? "",
        body: (
          <>
            <p className="acc-detail__line">
              <StatusMark status={status} label={statusLabel(status)} />
            </p>
            {status === "beta" ? (
              <p className="form-field__hint">{t("accounts.betaNote")}</p>
            ) : null}
            {status === "reconnect" ? (
              <p className="form-note">{t("accounts.reconnectNote")}</p>
            ) : null}
            <p className="form-field__hint">
              {t(
                inbox.kind === "primary"
                  ? "accounts.disconnect.primaryNote"
                  : "accounts.disconnect.mailNote",
              )}
            </p>
            {linkedCalendar ? (
              <div className="acc-detail__calendar">
                <span>{t("accounts.calendar.alsoLinked")}</span>
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() =>
                    setSelected({
                      kind: "calendar",
                      source: linkedCalendar.source,
                      id: linkedCalendar.id,
                      name: linkedCalendar.displayName || t("accounts.calendar.name"),
                      email: linkedCalendar.email,
                    })
                  }
                >
                  {t("accounts.calendar.manage")}
                </button>
              </div>
            ) : null}
          </>
        ),
        canDisconnect: disconnectOf(inbox).kind !== "none",
        reconnect: status === "reconnect",
      };
    }
    if (selected.kind === "calendar") {
      return {
        title: selected.name,
        subtitle: selected.email,
        body: <p className="form-field__hint">{t("accounts.disconnect.calendarNote")}</p>,
        canDisconnect: true,
        reconnect: false,
      };
    }
    if (selected.kind === "drive") {
      return {
        title: t("files.source.google"),
        subtitle: selected.email,
        body: <p className="form-field__hint">{t("accounts.disconnect.driveNote")}</p>,
        canDisconnect: true,
        reconnect: false,
      };
    }
    return {
      title: t("accounts.device.title"),
      subtitle: t("accounts.device.sub"),
      body: (
        <>
          <p className="acc-detail__soon">{t("accounts.device.soonTitle")}</p>
          <p className="form-field__hint">{t("accounts.device.soonBody")}</p>
        </>
      ),
      canDisconnect: false,
      reconnect: false,
    };
  })();

  const loading = inboxes.isPending && !inboxes.data;

  return (
    <div className="screen accounts-screen">
      <div className="accounts">
        <a className="detail-back accounts__back" {...settings}>
          <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
          {t("settings.title")}
        </a>
        <div className="accounts__intro">
          <h1 className="screen-title">{t("accounts.title")}</h1>
          <p className="accounts__lede">{t("accounts.lede")}</p>
        </div>

        <section className="acc-group" aria-labelledby="acc-mail">
          <h2 id="acc-mail" className="acc-group__title">
            {t("accounts.group.mail")}
          </h2>
          {inboxes.isError && !inboxes.data ? (
            <ProblemState kind="error" onRetry={() => void inboxes.refetch()} compact />
          ) : loading ? (
            <SkeletonRows rows={3} />
          ) : (
            <ul className="acc-list card">
              {mail.map((inbox) => {
                const status = statusOf(inbox);
                return (
                  <Row
                    key={inbox.id ?? "primary"}
                    tile={<SourceBadge inbox={inbox} size={30} />}
                    name={t(providerTitleKey(inbox))}
                    sub={inbox.email ?? ""}
                    status={<StatusMark status={status} label={statusLabel(status)} />}
                    onClick={() => setSelected({ kind: "inbox", inbox })}
                  />
                );
              })}
              {calendars.map((c) => {
                const status: AccountStatus = c.needsReconnect ? "reconnect" : "connected";
                const name = c.displayName || t("accounts.calendar.name");
                return (
                  <Row
                    key={`${c.source}-${c.id}`}
                    tile={
                      <SourceBadge
                        inbox={{ provider: c.provider as InboxOption["provider"], purpose: null }}
                        size={30}
                      />
                    }
                    name={name}
                    sub={t("accounts.calendar.sub", { email: c.email })}
                    status={<StatusMark status={status} label={statusLabel(status)} />}
                    onClick={() =>
                      setSelected({
                        kind: "calendar",
                        source: c.source,
                        id: c.id,
                        name,
                        email: c.email,
                      })
                    }
                  />
                );
              })}
              <Row
                tile={<LetterTile letter="+" tone="add" />}
                name={t("accounts.add.title")}
                sub={t("accounts.add.sub")}
                status={<StatusMark status="add" label={t("accounts.status.add")} />}
                onClick={() => setAdding(true)}
              />
            </ul>
          )}
        </section>

        {limits.data || googleDrive.data ? (
          <section className="acc-group" aria-labelledby="acc-files">
            <h2 id="acc-files" className="acc-group__title">
              {t("accounts.group.files")}
            </h2>
            <ul className="acc-list card">
              {limits.data ? (
                <Row
                  tile={<LetterTile letter="K" tone="klorn" />}
                  name={t("files.source.klorn")}
                  sub={t("accounts.klorn.sub", {
                    used: formatSize(limits.data.usedBytes, intlTag),
                  })}
                  status={<StatusMark status="connected" label={t("accounts.status.connected")} />}
                  onClick={() => notify(t("accounts.klorn.note"), "info")}
                />
              ) : null}
              {(googleDrive.data ?? []).map((a) => {
                const status: AccountStatus = a.needsReconnect ? "reconnect" : "connected";
                return (
                  <Row
                    key={a.id}
                    tile={<LetterTile letter="D" tone="drive" />}
                    name={t("files.source.google")}
                    sub={t("accounts.drive.sub", { email: a.email })}
                    status={<StatusMark status={status} label={statusLabel(status)} />}
                    onClick={() => setSelected({ kind: "drive", id: a.id, email: a.email })}
                  />
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="acc-group" aria-labelledby="acc-device">
          <h2 id="acc-device" className="acc-group__title">
            {t("accounts.group.device")}
          </h2>
          <ul className="acc-list card">
            <Row
              tile={<LetterTile letter="C" tone="device" />}
              name={t("accounts.device.title")}
              sub={t("accounts.device.sub")}
              status={<StatusMark status="ask" label={t("accounts.device.turnOn")} />}
              onClick={() => setSelected({ kind: "device" })}
            />
          </ul>
        </section>

        <p className="accounts__foot">
          <Icon name="lock" size={14} strokeWidth={2} />
          {t("accounts.foot")}
        </p>
      </div>

      <Sheet
        closeButton
        open={!!detail}
        onClose={close}
        title={detail?.title ?? ""}
        subtitle={detail?.subtitle}
        footer={
          detail?.canDisconnect ? (
            confirming ? (
              <>
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => setConfirming(false)}
                >
                  {t("settings.ui.cancel")}
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  disabled={working}
                  onClick={() => void disconnect()}
                >
                  {working ? t("accounts.disconnecting") : t("accounts.disconnect.confirm")}
                </button>
              </>
            ) : (
              <>
                {detail.reconnect ? (
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => {
                      close();
                      setAdding(true);
                    }}
                  >
                    {t("accounts.reconnect")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button--quiet acc-detail__danger"
                  onClick={() => setConfirming(true)}
                >
                  {t("accounts.disconnect.button")}
                </button>
              </>
            )
          ) : undefined
        }
      >
        {detail?.body}
        {confirming ? (
          <p className="form-note" role="alert">
            {t("accounts.disconnect.question", { name: detail?.subtitle || detail?.title || "" })}
          </p>
        ) : null}
      </Sheet>

      <AddAccountSheet
        open={adding}
        onClose={() => setAdding(false)}
        primaryConnected={me.data?.googleConnected !== false}
        available={{
          OUTLOOK: !!outlook.data,
          NAVER: !!naver.data,
          ICLOUD: !!icloud.data,
          IMAP: !!generic.data,
        }}
        googleDrive={!!googleDrive.data}
      />
    </div>
  );
}
