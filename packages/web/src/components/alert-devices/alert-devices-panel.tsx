"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { PANEL, SECTION_TITLE } from "../../app/settings/_sections/shared";
import {
  type AlertEndpoint,
  type AlertEndpointList,
  type AlertTone,
  alertEndpointName,
  alertRowStatus,
  isPushEndpoint,
} from "../../lib/alert-devices";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { getPushDeviceId, unregisterPushSubscription } from "../../lib/push";
import { formatRelativeIntl } from "../../lib/text";
import { useToast } from "../toast";
import Button from "../ui/button";
import { PhoneSetup } from "./phone-setup";

const BASE = "/api/notifications/alert-endpoints";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; list: AlertEndpointList };

// Dot colour per tone. Every dot sits next to its status text: the colour
// repeats the words, it never replaces them.
const DOT: Record<AlertTone, string> = {
  ok: "bg-state-ok-ink",
  warn: "bg-state-warn-ink",
  neutral: "bg-ink-dim",
  off: "border border-ink-dim bg-transparent",
};

const STATUS_INK: Record<AlertTone, string> = {
  ok: "text-ink-mid",
  warn: "text-state-warn-ink",
  neutral: "text-ink-mid",
  off: "text-ink-mid",
};

function rowKey(e: AlertEndpoint): string {
  return e.kind === "desktop" ? `desktop-${e.app}` : `${e.kind}-${e.id}`;
}

/** Settings → Notifications → "Where you get alerts" (N8). */
export function AlertDevicesPanel() {
  const { t, locale } = useT();
  const { toast } = useToast();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [phoneOpen, setPhoneOpen] = useState(false);
  const titleId = useId();
  const phoneSetupId = useId();

  const load = useCallback(async () => {
    try {
      const deviceId = getPushDeviceId();
      const list = await apiFetch<AlertEndpointList>(BASE, {
        headers: deviceId ? { "X-Push-Device": deviceId } : {},
      });
      setState({ status: "ready", list });
    } catch (err) {
      console.error("[ALERT-DEVICES] load failed:", err);
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // One flag per row, so a second row's request never re-enables the first.
  const markBusy = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const ago = (at: string | null) => formatRelativeIntl(at, locale, t("alertDevices.justNow"));

  const sendTest = async (e: Extract<AlertEndpoint, { kind: "web" | "native" }>) => {
    markBusy(rowKey(e), true);
    try {
      const res = await apiFetch<{ sent: boolean }>(`${BASE}/${e.kind}/${e.id}/test`, {
        method: "POST",
      });
      toast(
        res.sent ? t("alertDevices.toast.testSent") : t("alertDevices.toast.testNotSent"),
        res.sent ? "success" : "error",
      );
      // A dead endpoint found by the test is evicted server-side; refresh.
      if (!res.sent) await load();
    } catch (err) {
      const limited = err instanceof Error && err.message.startsWith("API 429");
      toast(
        limited ? t("alertDevices.toast.rateLimited") : t("alertDevices.toast.testNotSent"),
        "error",
      );
    } finally {
      markBusy(rowKey(e), false);
    }
  };

  const remove = async (e: Extract<AlertEndpoint, { kind: "web" | "native" }>) => {
    markBusy(rowKey(e), true);
    try {
      if (e.kind === "web" && e.current) {
        // This browser: unsubscribe here too, or the settings page's
        // auto-repair would re-register it on the next visit.
        // Skip it when no service worker is registered: serviceWorker.ready
        // would never settle and the button would stay disabled.
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) await unregisterPushSubscription();
      }
      await apiFetch(`${BASE}/${e.kind}/${e.id}`, { method: "DELETE" }).catch((err: unknown) => {
        // Already gone (the unsubscribe above removed it) is the goal.
        if (!(err instanceof Error && err.message.startsWith("API 404"))) throw err;
      });
      toast(t("alertDevices.toast.removed"), "success");
      await load();
    } catch (err) {
      console.error("[ALERT-DEVICES] remove failed:", err);
      toast(t("alertDevices.toast.removeFailed"), "error");
    } finally {
      markBusy(rowKey(e), false);
    }
  };

  return (
    <section aria-labelledby={titleId} className="mb-8">
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("alertDevices.title")}
      </h2>
      <div className={`${PANEL} p-5`}>
        <p className="text-role-meta text-ink-mid">{t("alertDevices.helper")}</p>

        {state.status === "loading" && (
          <p className="mt-3 text-role-meta text-ink-dim" role="status">
            {t("alertDevices.loading")}
          </p>
        )}

        {state.status === "error" && (
          <div className="mt-3 flex items-center gap-3" role="alert">
            <p className="text-role-meta text-state-danger-ink">{t("alertDevices.loadFailed")}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("alertDevices.retry")}
            </Button>
          </div>
        )}

        {state.status === "ready" && (
          <ul className="mt-3 divide-y divide-line-soft rounded-card border border-line-soft">
            {state.list.endpoints.length === 0 && (
              <li className="px-4 py-3 text-role-meta text-ink-mid">{t("alertDevices.empty")}</li>
            )}
            {state.list.endpoints.map((e) => {
              const name = alertEndpointName(e);
              const label = t(name.key, name.params);
              const status = alertRowStatus(e);
              const rowBusy = busy.has(rowKey(e));
              // The buttons say "Send test" / "Remove"; the row's name describes
              // which device, without changing their accessible names.
              const nameId = `${titleId}-${rowKey(e)}`;
              return (
                <li
                  key={rowKey(e)}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p id={nameId} className="text-role-body text-ink">
                      {label}
                      {e.kind === "web" && e.current && (
                        <span className="ml-2 text-role-meta text-ink-dim">
                          {t("alertDevices.thisBrowser")}
                        </span>
                      )}
                    </p>
                    <p
                      className={`mt-0.5 flex items-center gap-1.5 text-role-meta ${STATUS_INK[status.tone]}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-block size-2 shrink-0 rounded-full ${DOT[status.tone]}`}
                      />
                      {t(status.key, { ago: ago(status.at) })}
                    </p>
                  </div>
                  {isPushEndpoint(e) && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={rowBusy}
                        aria-describedby={nameId}
                        onClick={() => void sendTest(e)}
                      >
                        {rowBusy ? t("alertDevices.sending") : t("alertDevices.sendTest")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={rowBusy}
                        aria-describedby={nameId}
                        onClick={() => void remove(e)}
                      >
                        {t("alertDevices.remove")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
            {!state.list.phoneConfigured && (
              <li className="px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-role-body text-ink">{t("alertDevices.phone.name")}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-role-meta text-ink-mid">
                      <span
                        aria-hidden="true"
                        className={`inline-block size-2 shrink-0 rounded-full ${DOT.off}`}
                      />
                      {t("alertDevices.phone.notSetUp")}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 self-start sm:self-auto"
                    aria-expanded={phoneOpen}
                    aria-controls={phoneSetupId}
                    onClick={() => setPhoneOpen((open) => !open)}
                  >
                    {phoneOpen ? t("alertDevices.phone.hide") : t("alertDevices.phone.setUp")}
                  </Button>
                </div>
                {phoneOpen && <PhoneSetup id={phoneSetupId} />}
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
