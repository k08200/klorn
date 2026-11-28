"use client";

// Push, app side, inside the Capacitor shell (Structure A) — parity with
// apps/mobile/src/push/PushLayer.tsx: the priming screen (asked once, after
// sign-in, before the OS prompt), the in-app banner for a push that arrives
// while the app is open, Android's own notifications for data-only messages
// (./local-notify.ts — the only way to get action buttons there), and what a
// tap or an action button does. "Send draft" (iOS) and "Review" (Android)
// NEVER send: they open the draft, shown in full, where sending is one more
// explicit tap. Loaded only in the shell (components/push-register.tsx).

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../components/toast";
import { apiFetch } from "../api";
import { useT } from "../i18n";
import { parseDataPush } from "./android-push";
import { hapticSuccess, hapticWarning } from "./haptics";
import {
  appIsActive,
  installLocalNotificationListeners,
  isAndroid,
  setupAndroidNotifications,
  showDataPush,
} from "./local-notify";
import {
  enableNativePush,
  type IncomingPush,
  installPushListeners,
  markPrimed,
  pushPermission,
  wasPrimed,
} from "./native-push";
import { intentOf, type TriageIntent, triageRequest, webPathFromPush } from "./push-intent";

const BANNER_MS = 6000;
const DELIVERED_CAP = 100;

/** FCM message ids already handled (the plugin can deliver its last message again on launch). */
const delivered = new Set<string>();

function firstDelivery(id: string | undefined): boolean {
  if (!id) return true;
  if (delivered.has(id)) return false;
  delivered.add(id);
  if (delivered.size > DELIVERED_CAP) delivered.delete(delivered.values().next().value as string);
  return true;
}

function runTriage(intent: TriageIntent): Promise<unknown> {
  const { path, body } = triageRequest(intent, new Date());
  return apiFetch(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
}

function PushPriming({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try {
      const result = await enableNativePush({ prompt: true });
      await markPrimed(result === "granted" ? "enabled" : "later");
      if (result === "denied") toast(t("nativePush.denied"), "info");
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const later = async () => {
    await markPrimed("later");
    onDone();
  };
  return (
    // Escape — and so Android back (native-bridge.tsx) — means "Not now".
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="native-push-priming-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") void later();
      }}
      className="fixed inset-0 z-[110] flex flex-col justify-between overflow-y-auto bg-surface-panel px-6 pb-safe pt-safe text-ink"
    >
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 py-8">
        <div aria-hidden="true" className="rounded-card border border-line bg-surface-app p-4">
          <p className="flex items-baseline justify-between gap-3 text-role-label">
            <strong className="font-semibold">{t("nativePush.priming.sampleTitle")}</strong>
            <span className="text-role-caption text-ink-mid">{t("nativePush.priming.now")}</span>
          </p>
          <p className="mt-1 text-role-body text-ink-mid">{t("nativePush.priming.sampleBody")}</p>
          <p className="mt-3 border-t border-line pt-3 text-role-caption text-ink-mid">
            QUEUE · INFO · SILENT — {t("nativePush.priming.quietSample")}
          </p>
        </div>
        <div>
          <h1 id="native-push-priming-title" className="text-role-page font-semibold">
            {t("nativePush.priming.title")}
          </h1>
          <p className="mt-2 text-role-body text-ink-mid">{t("nativePush.priming.body")}</p>
          <ul className="mt-4 space-y-2 text-role-body">
            <li>{t("nativePush.priming.point.push")}</li>
            <li>{t("nativePush.priming.point.actions")}</li>
            <li>{t("nativePush.priming.point.settings")}</li>
          </ul>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-md flex-col gap-2 pb-6">
        <button
          type="button"
          disabled={busy}
          onClick={() => void enable()}
          className="inline-flex min-h-11 items-center justify-center rounded-control bg-accent-solid px-5 text-role-label font-medium text-accent-solid-ink transition hover:bg-accent-solid-hover focus-ring disabled:opacity-60"
        >
          {t("nativePush.priming.enable")}
        </button>
        <button
          type="button"
          onClick={() => void later()}
          className="inline-flex min-h-11 items-center justify-center rounded-control px-5 text-role-label text-ink-mid transition hover:bg-surface-hover focus-ring"
        >
          {t("nativePush.priming.later")}
        </button>
      </div>
    </div>
  );
}

function ForegroundBanner({
  push,
  onOpen,
  onClose,
}: {
  push: IncomingPush;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  useEffect(() => {
    const timer = setTimeout(onClose, BANNER_MS);
    return () => clearTimeout(timer);
  }, [onClose]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 top-[max(env(safe-area-inset-top),12px)] z-[105] mx-auto flex max-w-md items-stretch rounded-card border border-line bg-surface-panel shadow-lg"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 flex-col items-start px-4 py-3 text-left focus-ring"
      >
        <span className="flex w-full items-baseline justify-between gap-3 text-role-label">
          <strong className="truncate font-semibold">{push.title}</strong>
          <span className="shrink-0 text-role-caption text-ink-mid">
            {t("nativePush.priming.now")}
          </span>
        </span>
        <span className="line-clamp-2 text-role-body text-ink-mid">{push.body}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="flex min-h-11 min-w-11 items-center justify-center text-ink-mid focus-ring"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

/** Mount once inside the signed-in shell (components/push-register.tsx). */
export default function NativePushLayer() {
  const { t } = useT();
  const { toast } = useToast();
  const router = useRouter();
  const [priming, setPriming] = useState(false);
  const [banner, setBanner] = useState<IncomingPush | null>(null);
  const closeBanner = useCallback(() => setBanner(null), []);
  // The latest router/t/toast for listeners installed once.
  const live = useRef({ router, t, toast });
  useEffect(() => {
    live.current = { router, t, toast };
  });

  // Ask once: only on a device that has not answered (never by itself on launch).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const state = await pushPermission();
      if (!alive) return;
      if (state === "granted") {
        // Tokens rotate: re-register silently on every launch.
        await enableNativePush({ prompt: false });
      } else if (state === "prompt" && !(await wasPrimed()) && alive) {
        setPriming(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Android: channels (PUSH = importance high) and the action buttons, in the app language.
  useEffect(() => {
    void setupAndroidNotifications({
      later: t("nativePush.action.later"),
      notUrgent: t("nativePush.action.notUrgent"),
      done: t("nativePush.action.done"),
      pushChannel: t("nativePush.channel.push"),
      pushChannelBody: t("nativePush.channel.pushBody"),
      otherChannel: t("nativePush.channel.other"),
    });
  }, [t]);

  useEffect(() => {
    const go = (path: string) => live.current.router.push(path);
    // One handler for iOS actions, Android local-notification actions and taps.
    const onAction = (actionId: string, push: IncomingPush) => {
      const intent = intentOf(actionId, push.data);
      if (intent.kind === "open" || intent.kind === "review") {
        go(intent.path);
        return;
      }
      runTriage(intent)
        .then(() => {
          void hapticSuccess();
          const { t: tr, toast: show } = live.current;
          const message =
            intent.kind === "later"
              ? tr("mailV2.list.remind.set", { when: tr("mailV2.list.remind.today") })
              : intent.kind === "done"
                ? tr("nativePush.done")
                : tr("nativePush.notUrgent");
          show(message, "success");
        })
        .catch((err) => {
          // The mail itself, so the person can act by hand.
          console.error("[PUSH-DEVICE] notification action failed:", err);
          void hapticWarning();
          go(intent.fallback);
        });
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
  }, []);

  return (
    <>
      {priming && <PushPriming onDone={() => setPriming(false)} />}
      {banner && (
        <ForegroundBanner
          push={banner}
          onClose={closeBanner}
          onOpen={() => {
            router.push(webPathFromPush(banner.data));
            closeBanner();
          }}
        />
      )}
    </>
  );
}
