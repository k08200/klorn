/**
 * Delete account (App Store 5.1.1(v)): self-service, in the app, irreversible.
 * The user types their own address to confirm; DELETE /api/auth/account
 * removes the user and all their data (routes/auth.ts deleteUserAndAllData),
 * then the device is wiped and Welcome says the account was deleted. A store
 * subscription is not cancelled by this — Apple and Google own those — so
 * the screen says where to cancel it.
 */
import { type FormEvent, useState } from "react";
import { useMe } from "../../api/queries";
import { getServices } from "../../app/services";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/I18nProvider";
import { forgetPushToken } from "../../platform/push";
import { SettingsBack } from "./parts";

export function confirmationMatches(typed: string, email: string | null | undefined): boolean {
  return !!email && typed.trim().toLowerCase() === email.trim().toLowerCase();
}

export function DeleteAccountScreen() {
  const { t } = useI18n();
  const me = useMe();
  const { accountDeleted } = useSession();
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const email = me.data?.email;
  const ready = confirmationMatches(typed, email);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || working) return;
    setWorking(true);
    setFailed(false);
    const { ep } = getServices();
    try {
      await forgetPushToken((token) => ep.push.unregister(token));
      await ep.settings.deleteAccount();
      await accountDeleted();
    } catch {
      setFailed(true);
      setWorking(false);
    }
  };

  return (
    <div className="settings">
      <SettingsBack to={{ name: "settings" }} label={t("settings.title")} />
      <h1 className="screen-title">{t("settings.delete.title")}</h1>
      <section className="set-danger card">
        <p className="set-danger__lead">{t("settings.delete.lead")}</p>
        <ul className="set-danger__list">
          <li>{t("settings.delete.point.data")}</li>
          <li>{t("settings.delete.point.accounts")}</li>
          <li>{t("settings.delete.point.devices")}</li>
          <li>{t("settings.delete.point.store")}</li>
        </ul>
      </section>
      <form className="set-danger__form" onSubmit={(e) => void submit(e)}>
        <label className="form-field">
          <span className="form-field__label">
            {t("settings.delete.type", { email: email ?? "" })}
          </span>
          <input
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-describedby="delete-hint"
          />
          <span id="delete-hint" className="form-field__hint">
            {t("settings.delete.hint")}
          </span>
        </label>
        {failed ? (
          <p className="form-error" role="alert">
            {t("settings.delete.failed")}
          </p>
        ) : null}
        <button type="submit" className="button button--danger" disabled={!ready || working}>
          {working ? t("settings.delete.working") : t("settings.delete.confirm")}
        </button>
      </form>
    </div>
  );
}
