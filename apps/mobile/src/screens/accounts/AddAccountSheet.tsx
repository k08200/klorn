/**
 * Add an account. Gmail, Outlook, another Google calendar and Google Drive
 * open the provider's consent in the SYSTEM browser (Google refuses OAuth in
 * a WebView); the server relays back to the app (platform/link-relay.ts).
 * Naver, iCloud and other IMAP mail take an app password here, which the
 * server verifies against the mail server before it stores anything
 * (routes/imap-connect.ts). Only the providers this deployment has are shown.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { isApiError, isEntitlementRefusal } from "../../api/client";
import type { ImapKind } from "../../api/endpoints";
import type { LinkStartResponse } from "../../api/wire";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { openExternal } from "../../platform/external";
import { Icon } from "../../ui/Icon";
import { PlansLink } from "../../ui/PlansLink";
import { Sheet } from "../../ui/Sheet";
import { SourceBadge } from "../../ui/SourceBadge";
import { notify } from "../../ui/StatusNote";
import { type AddProvider, availableProviders, BETA_PROVIDERS, imapFormProblem } from "./model";

type Flow = AddProvider | "CALENDAR" | "DRIVE";

const NAME_KEYS: Record<Flow, MessageKey> = {
  GOOGLE: "accounts.provider.gmail",
  OUTLOOK: "accounts.provider.outlook",
  NAVER: "accounts.provider.naver",
  ICLOUD: "accounts.provider.icloud",
  IMAP: "accounts.provider.imap",
  CALENDAR: "accounts.add.googleCalendar",
  DRIVE: "accounts.drive.add",
};

const SUB_KEYS: Record<Flow, MessageKey> = {
  GOOGLE: "accounts.add.sub.google",
  OUTLOOK: "accounts.add.sub.outlook",
  NAVER: "accounts.add.sub.imap",
  ICLOUD: "accounts.add.sub.icloud",
  IMAP: "accounts.add.sub.genericImap",
  CALENDAR: "accounts.add.sub.calendar",
  DRIVE: "accounts.drive.addSub",
};

const IMAP_OF: Partial<Record<Flow, ImapKind>> = {
  NAVER: "naver",
  ICLOUD: "icloud",
  IMAP: "generic",
};

const HELP_KEYS: Record<ImapKind, MessageKey> = {
  naver: "accounts.imap.help.naver",
  icloud: "accounts.imap.help.icloud",
  generic: "accounts.imap.help.generic",
};

interface AddAccountSheetProps {
  open: boolean;
  onClose: () => void;
  primaryConnected: boolean;
  available: Partial<Record<AddProvider, boolean>>;
  googleDrive: boolean;
}

export function AddAccountSheet({
  open,
  onClose,
  primaryConnected,
  available,
  googleDrive,
}: AddAccountSheetProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [needsPro, setNeedsPro] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", host: "" });

  useEffect(() => {
    if (!open) return;
    setFlow(null);
    setWaiting(false);
    setProblem(null);
    setNeedsPro(false);
    setForm({ email: "", password: "", host: "" });
  }, [open]);

  const mailFlows = availableProviders(available);
  const otherFlows: Flow[] = ["CALENDAR", ...(googleDrive ? (["DRIVE"] as const) : [])];

  const startBrowser = async (which: Flow) => {
    setBusy(true);
    setProblem(null);
    setNeedsPro(false);
    const { ep } = getServices();
    try {
      let res: LinkStartResponse;
      if (which === "GOOGLE") res = await ep.accounts.startGoogle(!primaryConnected);
      else if (which === "OUTLOOK") res = await ep.accounts.startOutlook();
      else if (which === "CALENDAR") res = await ep.accounts.startGoogleCalendar();
      else res = await ep.files.linkGoogle();
      await openExternal(res.url);
      setFlow(which);
      setWaiting(true);
    } catch (err) {
      if (isEntitlementRefusal(err)) setNeedsPro(true);
      else setProblem(t("accounts.add.startFailed"));
    } finally {
      setBusy(false);
    }
  };

  const pick = (which: Flow) => {
    if (IMAP_OF[which]) {
      setFlow(which);
      setProblem(null);
      return;
    }
    void startBrowser(which);
  };

  const imap = flow ? IMAP_OF[flow] : undefined;

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (!imap) return;
    const bad = imapFormProblem(form, imap === "generic");
    if (bad) {
      setProblem(t(`accounts.imap.problem.${bad}` as MessageKey));
      return;
    }
    setBusy(true);
    setProblem(null);
    setNeedsPro(false);
    try {
      const res = await getServices().ep.accounts.imapConnect(imap, {
        email: form.email.trim(),
        password: form.password,
        ...(imap === "generic" ? { host: form.host.trim() } : {}),
      });
      if (!res.ok) {
        setProblem(res.message ?? t("accounts.imap.failed"));
        return;
      }
      notify(t("accounts.imap.connected", { email: form.email.trim() }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mail", "inboxes"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
      ]);
      onClose();
    } catch (err) {
      if (isEntitlementRefusal(err)) setNeedsPro(true);
      else if (isApiError(err) && err.status === 429) setProblem(t("accounts.imap.tooMany"));
      else if (isApiError(err) && err.serverMessage) setProblem(err.serverMessage);
      else setProblem(t("accounts.imap.failed"));
    } finally {
      setBusy(false);
    }
  };

  const proNote = needsPro ? (
    <p className="form-note" role="status">
      {t("accounts.add.needsPro")} <PlansLink />
    </p>
  ) : null;
  const errorNote = problem ? (
    <p className="form-error" role="alert">
      {problem}
    </p>
  ) : null;

  if (flow && waiting) {
    return (
      <Sheet closeButton open={open} onClose={onClose} title={t(NAME_KEYS[flow])}>
        <div className="acc-waiting">
          <span className="acc-waiting__icon" aria-hidden="true">
            <Icon name="external" size={24} />
          </span>
          <p className="acc-waiting__title">{t("accounts.add.inBrowser")}</p>
          <p className="form-field__hint">{t("accounts.add.inBrowserBody")}</p>
        </div>
      </Sheet>
    );
  }

  if (flow && imap) {
    const beta = flow !== "IMAP" && BETA_PROVIDERS.has(flow as "NAVER" | "ICLOUD");
    return (
      <Sheet
        closeButton
        open={open}
        onClose={onClose}
        title={t(NAME_KEYS[flow])}
        subtitle={beta ? t("accounts.status.beta") : undefined}
        footer={
          <>
            <button type="button" className="button button--quiet" onClick={() => setFlow(null)}>
              {t("settings.ui.back")}
            </button>
            <button
              type="submit"
              form="imap-form"
              className="button button--primary"
              disabled={busy}
            >
              {busy ? t("accounts.imap.checking") : t("accounts.imap.connect")}
            </button>
          </>
        }
      >
        <form id="imap-form" className="new-event" onSubmit={(e) => void connect(e)} noValidate>
          <p className="form-field__hint">{t(HELP_KEYS[imap])}</p>
          <label className="form-field">
            <span className="form-field__label">{t("accounts.imap.email")}</span>
            <input
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoComplete="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              data-autofocus
            />
          </label>
          <label className="form-field">
            <span className="form-field__label">{t("accounts.imap.password")}</span>
            <input
              type="password"
              autoComplete="off"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
            <span className="form-field__hint">{t("accounts.imap.passwordHint")}</span>
          </label>
          {imap === "generic" ? (
            <label className="form-field">
              <span className="form-field__label">{t("accounts.imap.host")}</span>
              <input
                type="text"
                inputMode="url"
                autoCapitalize="none"
                placeholder="imap.example.com"
                value={form.host}
                onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
              />
            </label>
          ) : null}
          {errorNote}
          {proNote}
        </form>
      </Sheet>
    );
  }

  const row = (which: Flow) => {
    const beta = BETA_PROVIDERS.has(which as "OUTLOOK");
    const provider = which === "CALENDAR" || which === "DRIVE" ? "GOOGLE" : (which as AddProvider);
    return (
      <li key={which}>
        <button
          type="button"
          className="acc-row__button"
          onClick={() => pick(which)}
          disabled={busy}
        >
          <SourceBadge inbox={{ provider, purpose: null }} size={30} />
          <span className="acc-row__text">
            <span className="acc-row__name">
              {t(NAME_KEYS[which])}
              {beta ? <span className="acc-beta">{t("accounts.status.beta")}</span> : null}
            </span>
            <span className="acc-row__sub">{t(SUB_KEYS[which])}</span>
          </span>
          <Icon
            name={IMAP_OF[which] ? "chevronRight" : "external"}
            size={16}
            strokeWidth={2}
            className="acc-row__chevron"
          />
        </button>
      </li>
    );
  };

  return (
    <Sheet
      closeButton
      open={open}
      onClose={onClose}
      title={t("accounts.add.title")}
      subtitle={t("accounts.add.lede")}
    >
      <section className="acc-group">
        <h3 className="acc-group__title">{t("accounts.add.mail")}</h3>
        <ul className="acc-list card">{mailFlows.map(row)}</ul>
      </section>
      <section className="acc-group">
        <h3 className="acc-group__title">{t("accounts.add.other")}</h3>
        <ul className="acc-list card">{otherFlows.map(row)}</ul>
      </section>
      {errorNote}
      {proNote}
      <p className="accounts__foot">
        <Icon name="lock" size={14} strokeWidth={2} />
        {t("accounts.foot")}
      </p>
    </Sheet>
  );
}
