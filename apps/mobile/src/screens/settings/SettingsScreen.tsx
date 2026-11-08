/**
 * Settings: the account, Accounts & sources, app language (this app only —
 * notification language is the server's and lives under Notifications),
 * appearance, notifications, the plan, legal links, the version, sign out and
 * account deletion (App Store 5.1.1(v): self-service, reachable in the app).
 */
import { useEffect, useState } from "react";
import { useInboxes, useMe } from "../../api/queries";
import { useBillingStatus } from "../../api/queries-hub";
import { getServices } from "../../app/services";
import { useTheme } from "../../app/theme";
import { useSession } from "../../auth/session";
import { APP_VERSION } from "../../config";
import { isLocale, LOCALE_NAMES, LOCALES } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { openExternal } from "../../platform/external";
import { forgetPushToken, type PushPermission, pushPermission } from "../../platform/push";
import type { SettingsSection } from "../../router/routes";
import { Icon } from "../../ui/Icon";
import { initialsOf } from "../today/model";
import { DeleteAccountScreen } from "./DeleteAccountScreen";
import { NotificationsScreen } from "./NotificationsScreen";
import { PlansScreen } from "./PlansScreen";
import { PRIVACY_URL, SettingsBack, SettingsRow, TERMS_URL } from "./parts";
import { planLabel } from "./plans-model";
import "./settings.css";

function SettingsHome() {
  const { t, locale, override, setOverride } = useI18n();
  const { choice, setChoice } = useTheme();
  const { signOut } = useSession();
  const me = useMe();
  const inboxes = useInboxes();
  const billing = useBillingStatus();
  const [permission, setPermission] = useState<PushPermission>("unsupported");
  useEffect(() => {
    void pushPermission().then(setPermission);
  }, []);
  const user = me.data;
  const accounts = inboxes.data?.inboxes.filter(
    (i) => i.kind === "linked" || user?.googleConnected !== false,
  ).length;

  return (
    <div className="settings">
      <SettingsBack to={{ name: "today" }} label={t("tab.today")} />
      <h1 className="screen-title">{t("settings.title")}</h1>

      {user ? (
        <section className="set-profile card" aria-label={t("settings.profile")}>
          <span className="avatar set-profile__avatar" aria-hidden="true">
            {initialsOf(user.name, user.email)}
          </span>
          <span className="set-profile__text">
            <span className="set-profile__name">{user.name ?? user.email}</span>
            <span className="set-profile__email">{user.email}</span>
          </span>
        </section>
      ) : null}

      <ul className="set-list card">
        <SettingsRow
          icon="mail"
          label={t("accounts.title")}
          value={
            accounts === undefined ? undefined : t("settings.accountsCount", { count: accounts })
          }
          to={{ name: "accounts" }}
        />
      </ul>

      <section className="set-group" aria-labelledby="set-app">
        <h2 id="set-app" className="set-group__title">
          {t("settings.group.app")}
        </h2>
        <ul className="set-list card">
          <li className="set-row">
            <label className="set-row__control">
              <Icon name="globe" size={20} className="set-row__icon" />
              <span className="set-row__label">{t("accounts.language")}</span>
              <select
                className="set-row__select"
                value={override ?? "device"}
                onChange={(e) => setOverride(isLocale(e.target.value) ? e.target.value : null)}
              >
                <option value="device">
                  {t("accounts.theme.system")} ({LOCALE_NAMES[locale]})
                </option>
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_NAMES[l]}
                  </option>
                ))}
              </select>
            </label>
          </li>
          <li className="set-row set-row--stack">
            <span className="set-row__control set-row__control--static">
              <Icon name="sparkSmall" size={20} className="set-row__icon" />
              <span className="set-row__label" id="theme-label">
                {t("accounts.theme")}
              </span>
            </span>
            <div className="segmented set-theme" role="radiogroup" aria-labelledby="theme-label">
              {(["system", "light", "dark"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={choice === c}
                  className="segmented__item"
                  onClick={() => setChoice(c)}
                >
                  {t(`accounts.theme.${c}`)}
                </button>
              ))}
            </div>
          </li>
          <SettingsRow
            icon="bell"
            label={t("settings.notifications")}
            value={
              permission === "unsupported"
                ? undefined
                : t(
                    permission === "granted"
                      ? "settings.push.on"
                      : permission === "denied"
                        ? "settings.push.off"
                        : "settings.push.ask",
                  )
            }
            to={{ name: "settings", section: "notifications" }}
          />
        </ul>
      </section>

      <section className="set-group" aria-labelledby="set-plan">
        <h2 id="set-plan" className="set-group__title">
          {t("settings.group.plan")}
        </h2>
        <ul className="set-list card">
          <SettingsRow
            icon="card"
            label={t("plans.title")}
            value={planLabel(t, billing.data?.planName ?? user?.plan)}
            to={{ name: "settings", section: "plans" }}
          />
        </ul>
      </section>

      <section className="set-group" aria-labelledby="set-about">
        <h2 id="set-about" className="set-group__title">
          {t("settings.group.about")}
        </h2>
        <ul className="set-list card">
          <SettingsRow
            icon="lock"
            label={t("welcome.privacy")}
            onClick={() => void openExternal(PRIVACY_URL)}
            external
          />
          <SettingsRow
            icon="doc"
            label={t("welcome.terms")}
            onClick={() => void openExternal(TERMS_URL)}
            external
          />
          <SettingsRow icon="info" label={t("settings.version")} value={APP_VERSION} />
        </ul>
      </section>

      <button
        type="button"
        className="button button--quiet settings__signout"
        onClick={() => {
          void forgetPushToken((token) => getServices().ep.push.unregister(token)).finally(
            () => void signOut(),
          );
        }}
      >
        {t("accounts.signOut")}
      </button>
      <ul className="set-list card">
        <SettingsRow
          icon="trash"
          label={t("settings.delete.title")}
          to={{ name: "settings", section: "delete-account" }}
          danger
        />
      </ul>
    </div>
  );
}

export function SettingsScreen({ section }: { section?: SettingsSection }) {
  return (
    <div className="screen settings-screen">
      {section === "notifications" ? (
        <NotificationsScreen />
      ) : section === "plans" ? (
        <PlansScreen />
      ) : section === "delete-account" ? (
        <DeleteAccountScreen />
      ) : (
        <SettingsHome />
      )}
    </div>
  );
}
