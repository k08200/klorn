/**
 * Push, app side: the priming screen (asked once, after sign-in, before the
 * OS prompt — and only PUSH-lane mail rings), the in-app banner for a push
 * that arrives while the app is open, Android's own notifications for
 * data-only messages (push/android.ts — the only way to get action buttons
 * there), and what a tap or an action button does. "Send draft" (iOS) and
 * "Review" (Android) never send: they open the approval card, where sending
 * is one more explicit tap (and on iOS the button already required unlock).
 */
import { useEffect, useState } from "react";
import { getServices } from "../app/services";
import { MOCK_API } from "../config";
import type { MessageKey } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import {
  appIsActive,
  installLocalNotificationListeners,
  isAndroid,
  setupAndroidNotifications,
  showDataPush,
} from "../platform/local-notify";
import {
  enablePush,
  type IncomingPush,
  installPushListeners,
  markPrimed,
  pushPermission,
  wasPrimed,
} from "../platform/push";
import { useRouter } from "../router/Router";
import { Icon } from "../ui/Icon";
import { notify } from "../ui/StatusNote";
import { parseDataPush } from "./android";
import { intentOf, LATER_MS, type PushIntent, routeFromPush } from "./route";
import "./push.css";

const BANNER_MS = 6000;

type TriageIntent = Extract<PushIntent, { kind: "snooze" | "done" | "notUrgent" }>;

const TRIAGE_TOAST: Record<TriageIntent["kind"], MessageKey> = {
  snooze: "push.snoozed",
  done: "push.done",
  notUrgent: "push.notUrgent",
};

/** The one request behind Later / Done / Not urgent, by email id when the push has one. */
function triageRun(intent: TriageIntent): Promise<unknown> {
  const { ep } = getServices();
  const { target } = intent;
  const byEmail = "emailId" in target;
  switch (intent.kind) {
    case "snooze": {
      const until = new Date(Date.now() + LATER_MS);
      return byEmail
        ? ep.triage.snoozeByEmail(target.emailId, until)
        : ep.triage.snooze(target.attentionItemId, until);
    }
    case "done":
      return byEmail ? ep.triage.doneByEmail(target.emailId) : ep.triage.done(target.attentionItemId);
    case "notUrgent":
      // QUEUE, through the same lane override as a move in the app (a judge
      // learning signal). By item first (route.ts laneTargetOf).
      return byEmail
        ? ep.triage.moveLane(target.emailId, "QUEUE")
        : ep.triage.moveLaneByItem(target.attentionItemId, "QUEUE");
  }
}

/** FCM message ids already handled (the plugin can deliver its last message again on launch). */
const delivered = new Set<string>();

function firstDelivery(id: string | undefined): boolean {
  if (!id) return true;
  if (delivered.has(id)) return false;
  delivered.add(id);
  if (delivered.size > 100) delivered.delete(delivered.values().next().value as string);
  return true;
}

function useForcedPriming(): boolean {
  // Mock / dev builds: `?priming=1` shows the screen (screenshots, review).
  if (!(MOCK_API || import.meta.env.DEV)) return false;
  try {
    return new URLSearchParams(window.location.search).get("priming") === "1";
  } catch {
    return false;
  }
}

export function PushPriming({ open, onDone }: { open: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const enable = async () => {
    setBusy(true);
    const { ep } = getServices();
    const result = await enablePush((token, platform) => ep.push.register(token, platform), {
      prompt: true,
    });
    await markPrimed(result === "granted" ? "enabled" : "later");
    setBusy(false);
    if (result === "denied") notify(t("push.denied"), "info");
    onDone();
  };
  const later = async () => {
    await markPrimed("later");
    onDone();
  };
  return (
    <div className="priming" role="dialog" aria-modal="true" aria-labelledby="priming-h">
      <div className="priming__art" aria-hidden="true">
        <div className="priming__note priming__note--push">
          <span className="priming__app">K</span>
          <span className="priming__note-text">
            <span className="priming__note-head">
              <strong>{t("push.priming.sampleTitle")}</strong>
              <span>{t("push.priming.now")}</span>
            </span>
            <span>{t("push.priming.sampleBody")}</span>
          </span>
        </div>
        <div className="priming__note priming__note--quiet">
          <span className="priming__quiet-lanes">QUEUE · INFO · SILENT</span>
          <span>{t("push.priming.quietSample")}</span>
        </div>
      </div>
      <div className="priming__text">
        <h1 id="priming-h" className="priming__title">
          {t("push.priming.title")}
        </h1>
        <p className="priming__body">{t("push.priming.body")}</p>
        <ul className="priming__points">
          <li>
            <Icon name="bell" size={18} />
            {t("push.priming.point.push")}
          </li>
          <li>
            <Icon name="lock" size={18} />
            {t("push.priming.point.actions")}
          </li>
          <li>
            <Icon name="gear" size={18} />
            {t("push.priming.point.settings")}
          </li>
        </ul>
      </div>
      <div className="priming__actions">
        <button
          type="button"
          className="button button--primary priming__enable"
          disabled={busy}
          onClick={() => void enable()}
          data-autofocus
        >
          {t("push.priming.enable")}
        </button>
        <button type="button" className="button button--plain" onClick={() => void later()}>
          {t("push.priming.later")}
        </button>
      </div>
    </div>
  );
}

function ForegroundBanner({ push, onClose }: { push: IncomingPush | null; onClose: () => void }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  useEffect(() => {
    if (!push) return;
    const timer = setTimeout(onClose, BANNER_MS);
    return () => clearTimeout(timer);
  }, [push, onClose]);
  if (!push) return null;
  return (
    <div className="push-banner" role="status" aria-live="polite">
      <button
        type="button"
        className="push-banner__body"
        onClick={() => {
          navigate(routeFromPush(push.data));
          onClose();
        }}
      >
        <span className="priming__app" aria-hidden="true">
          K
        </span>
        <span className="push-banner__text">
          <span className="push-banner__head">
            <strong>{push.title}</strong>
            <span>{t("push.priming.now")}</span>
          </span>
          <span className="push-banner__line">{push.body}</span>
        </span>
      </button>
      <button type="button" className="push-banner__close" onClick={onClose}>
        <Icon name="close" size={18} label={t("settings.ui.close")} />
      </button>
    </div>
  );
}

/** Mount once inside the signed-in app. */
export function PushLayer() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const forced = useForcedPriming();
  const [priming, setPriming] = useState(forced);
  const [banner, setBanner] = useState<IncomingPush | null>(null);

  // Ask once: only on a device that has not answered (and never on launch by itself).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const state = await pushPermission();
      if (!alive) return;
      const { ep } = getServices();
      if (state === "granted") {
        // Tokens rotate: re-register silently on every launch.
        await enablePush((token, platform) => ep.push.register(token, platform), { prompt: false });
      } else if (state === "prompt" && !(await wasPrimed())) {
        if (alive) setPriming(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Android: channels (PUSH = importance high) and the action buttons, in the app language.
  useEffect(() => {
    void setupAndroidNotifications({
      later: t("push.action.later"),
      notUrgent: t("push.action.notUrgent"),
      done: t("push.action.done"),
      pushChannel: t("push.channel.push"),
      pushChannelBody: t("push.channel.pushBody"),
      otherChannel: t("push.channel.other"),
    });
  }, [t]);

  useEffect(() => {
    // One handler for iOS actions, Android local-notification actions and taps.
    const onAction = (actionId: string, push: IncomingPush) => {
      const intent = intentOf(actionId, push.data);
      if (intent.kind === "open" || intent.kind === "review") {
        navigate(intent.route);
        return;
      }
      void triageRun(intent)
        .then(() => notify(t(TRIAGE_TOAST[intent.kind])))
        .catch(() => navigate(intent.fallback));
    };
    const onForeground = (push: IncomingPush) => {
      if (!push.dataOnly) {
        setBanner(push);
        return;
      }
      // A data-only message: Android posts it with action buttons — or, with
      // the app on screen, shows the in-app banner instead (as iOS does).
      if (!isAndroid() || !firstDelivery(push.id)) return;
      const parsed = parseDataPush({ title: null, data: push.data }, Date.now());
      if (!parsed) return;
      void appIsActive().then((active) => {
        if (active) setBanner({ title: parsed.title, body: parsed.body, data: parsed.data });
        else void showDataPush(parsed);
      });
    };
    const removePush = installPushListeners({ onForeground, onAction });
    const removeLocal = installLocalNotificationListeners(onAction);
    return () => {
      removePush();
      removeLocal();
    };
  }, [navigate, t]);

  return (
    <>
      <PushPriming open={priming} onDone={() => setPriming(false)} />
      <ForegroundBanner push={banner} onClose={() => setBanner(null)} />
    </>
  );
}
