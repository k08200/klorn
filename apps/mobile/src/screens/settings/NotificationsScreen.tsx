/**
 * Notifications: this device's permission (asked from the priming screen,
 * never on launch), what Klorn notifies about, quiet hours and the
 * notification language. The toggles are the server's (GET / PATCH
 * /api/automations) because a push is composed on the server; the
 * notification language is NOT the app language (product vocabulary).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { hk, useNotificationSettings } from "../../api/queries-hub";
import type { NotificationSettingsWire } from "../../api/wire";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { isLocale, LOCALE_NAMES } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { type PushPermission, pushPermission } from "../../platform/push";
import { PushPriming } from "../../push/PushLayer";
import { ProblemState, SkeletonRows } from "../../ui/StateView";
import { notify } from "../../ui/StatusNote";
import { Switch } from "../../ui/Switch";
import { InterruptBudgetGroup } from "./InterruptBudgetGroup";
import { SettingsBack } from "./parts";

type Toggle = keyof Pick<
  NotificationSettingsWire,
  | "notifyEmailUrgent"
  | "notifyMeeting"
  | "notifyAgentProposal"
  | "notifyDailyBriefing"
  | "notifyTaskDue"
>;

const TOGGLES: Array<{ key: Toggle; label: MessageKey; hint: MessageKey }> = [
  { key: "notifyEmailUrgent", label: "settings.notify.push", hint: "settings.notify.pushHint" },
  { key: "notifyMeeting", label: "settings.notify.meeting", hint: "settings.notify.meetingHint" },
  {
    key: "notifyAgentProposal",
    label: "settings.notify.approvals",
    hint: "settings.notify.approvalsHint",
  },
  {
    key: "notifyDailyBriefing",
    label: "settings.notify.briefing",
    hint: "settings.notify.briefingHint",
  },
  { key: "notifyTaskDue", label: "settings.notify.tasks", hint: "settings.notify.tasksHint" },
];

export function NotificationsScreen() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const settings = useNotificationSettings();
  const [permission, setPermission] = useState<PushPermission>("unsupported");
  const [priming, setPriming] = useState(false);
  useEffect(() => {
    void pushPermission().then(setPermission);
  }, []);

  const save = async (patch: Partial<NotificationSettingsWire>) => {
    const before = queryClient.getQueryData<NotificationSettingsWire>(hk.notifications);
    if (before) queryClient.setQueryData(hk.notifications, { ...before, ...patch });
    try {
      const next = await getServices().ep.settings.updateNotifications(patch);
      queryClient.setQueryData(hk.notifications, { ...(before ?? {}), ...next });
    } catch {
      if (before) queryClient.setQueryData(hk.notifications, before);
      notify(t("settings.notify.saveFailed"), "error");
    }
  };

  const data = settings.data;
  const quietOn = Boolean(data?.quietHoursStart && data?.quietHoursEnd);

  return (
    <div className="settings">
      <SettingsBack to={{ name: "settings" }} label={t("settings.title")} />
      <h1 className="screen-title">{t("settings.notifications")}</h1>
      <p className="settings__lede">{t("settings.notify.lede")}</p>

      <section className="set-device card" aria-label={t("settings.push.device")}>
        <span className="set-device__text">
          <span className="set-device__title">{t("settings.push.device")}</span>
          <span className="set-device__sub">
            {t(
              permission === "granted"
                ? "settings.push.onBody"
                : permission === "denied"
                  ? "settings.push.offBody"
                  : permission === "prompt"
                    ? "settings.push.askBody"
                    : "settings.push.serverBody",
            )}
          </span>
        </span>
        {permission === "prompt" ? (
          <button type="button" className="button button--primary" onClick={() => setPriming(true)}>
            {t("push.priming.enable")}
          </button>
        ) : null}
      </section>

      {settings.isError && !data ? (
        <ProblemState kind="error" onRetry={() => void settings.refetch()} />
      ) : !data ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          <section className="set-group" aria-labelledby="set-what">
            <h2 id="set-what" className="set-group__title">
              {t("settings.notify.what")}
            </h2>
            <ul className="set-list card">
              {TOGGLES.map((toggle) => (
                <li key={toggle.key} className="set-row">
                  <label className="set-row__control set-row__control--toggle">
                    <span className="set-row__stack">
                      <span className="set-row__label">{t(toggle.label)}</span>
                      <span className="set-row__hint">{t(toggle.hint)}</span>
                    </span>
                    <Switch
                      checked={data[toggle.key]}
                      onChange={(on) => void save({ [toggle.key]: on })}
                    />
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="set-group" aria-labelledby="set-quiet">
            <h2 id="set-quiet" className="set-group__title">
              {t("settings.quiet.title")}
            </h2>
            <ul className="set-list card">
              <li className="set-row">
                <label className="set-row__control set-row__control--toggle">
                  <span className="set-row__stack">
                    <span className="set-row__label">{t("settings.quiet.toggle")}</span>
                    <span className="set-row__hint">{t("settings.quiet.hint")}</span>
                  </span>
                  <Switch
                    checked={quietOn}
                    onChange={(on) =>
                      void save(
                        on
                          ? { quietHoursStart: "22:00", quietHoursEnd: "07:00" }
                          : { quietHoursStart: null, quietHoursEnd: null },
                      )
                    }
                  />
                </label>
              </li>
              {quietOn ? (
                <li className="set-row">
                  <div className="set-row__control set-quiet">
                    <label className="form-field">
                      <span className="form-field__label">{t("settings.quiet.from")}</span>
                      <input
                        type="time"
                        value={data.quietHoursStart ?? ""}
                        onChange={(e) =>
                          e.target.value && void save({ quietHoursStart: e.target.value })
                        }
                      />
                    </label>
                    <label className="form-field">
                      <span className="form-field__label">{t("settings.quiet.to")}</span>
                      <input
                        type="time"
                        value={data.quietHoursEnd ?? ""}
                        onChange={(e) =>
                          e.target.value && void save({ quietHoursEnd: e.target.value })
                        }
                      />
                    </label>
                  </div>
                </li>
              ) : null}
            </ul>
          </section>

          <InterruptBudgetGroup data={data} save={save} />

          <section className="set-group" aria-labelledby="set-lang">
            <h2 id="set-lang" className="set-group__title">
              {t("settings.notifyLanguage.title")}
            </h2>
            <ul className="set-list card">
              <li className="set-row">
                <label className="set-row__control">
                  <span className="set-row__label">{t("settings.notifyLanguage.label")}</span>
                  <select
                    className="set-row__select"
                    value={data.notificationLanguage}
                    onChange={(e) => void save({ notificationLanguage: e.target.value })}
                  >
                    {data.notificationLanguages.map((l) => (
                      <option key={l} value={l}>
                        {isLocale(l) ? LOCALE_NAMES[l] : l}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            </ul>
            <p className="set-group__foot">{t("settings.notifyLanguage.hint")}</p>
          </section>
        </>
      )}
      <PushPriming
        open={priming}
        onDone={() => {
          setPriming(false);
          void pushPermission().then(setPermission);
        }}
      />
    </div>
  );
}
