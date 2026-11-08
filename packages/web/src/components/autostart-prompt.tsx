"use client";

import { useEffect, useId, useReducer, useRef } from "react";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import {
  answerToPersist,
  autostartPromptReducer,
  IDLE,
  promptVisible,
} from "../lib/native/autostart-prompt";
import { shellKind } from "../lib/native/shell";
import {
  isAutostartEnabled,
  readAutostartAnswer,
  setAutostart,
  writeAutostartAnswer,
} from "../lib/native/tauri-autostart";
import { captureClientError } from "../lib/sentry";
import { FLOATING } from "./pwa-prompts";
import { useToast } from "./toast";
import Button from "./ui/button";

/**
 * Windows desktop shell only: the one-time "start Klorn when you sign in?"
 * card. Start-at-sign-in stays OFF until the user accepts here or in Settings
 * (lib/native/autostart-prompt.ts holds the rules). Renders nothing in a
 * browser or the Capacitor app.
 */
export default function AutostartPrompt() {
  const { token, loading } = useAuth();
  const { t } = useT();
  const { toast } = useToast();
  const titleId = useId();
  const [state, dispatch] = useReducer(autostartPromptReducer, IDLE);
  const prevRef = useRef(state);

  useEffect(() => {
    if (loading || !token) return;
    const inShell = shellKind() === "tauri";
    const stored = inShell ? readAutostartAnswer() : null;
    let cancelled = false;
    (async () => {
      let enabled: boolean | null = null;
      if (inShell && !stored) {
        try {
          enabled = await isAutostartEnabled();
        } catch (err) {
          console.warn("[AUTOSTART] could not read start-at-sign-in:", err);
        }
      }
      if (!cancelled) dispatch({ type: "probed", inShell, stored, enabled });
    })();
    return () => {
      cancelled = true;
    };
  }, [token, loading]);

  // Persist the answer once, on the transition that closes the prompt.
  useEffect(() => {
    const answer = answerToPersist(prevRef.current, state);
    prevRef.current = state;
    if (!answer) return;
    writeAutostartAnswer(answer);
    if (answer === "failed") toast(t("desktop.autostart.failed"), "error");
  }, [state, t, toast]);

  // Signed out with the card still open: hide it; it returns after sign-in.
  if (!token || !promptVisible(state)) return null;
  const busy = state.phase === "enabling";

  const accept = async () => {
    dispatch({ type: "accept" });
    try {
      await setAutostart(true);
      dispatch({ type: "enabled" });
    } catch (err) {
      console.error("[AUTOSTART] enable failed:", err);
      captureClientError(err, { context: "autostart-prompt.accept" });
      dispatch({ type: "enableFailed" });
    }
  };

  return (
    <section className={FLOATING} aria-labelledby={titleId}>
      <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9 shrink-0" />
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-role-label text-ink">
          {t("desktop.autostart.prompt.title")}
        </p>
        <p className="text-role-caption text-ink-mid">{t("desktop.autostart.prompt.body")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={accept} loading={busy} disabled={busy}>
            {busy ? t("desktop.autostart.prompt.enabling") : t("desktop.autostart.prompt.accept")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatch({ type: "decline" })}
            disabled={busy}
          >
            {t("desktop.autostart.prompt.decline")}
          </Button>
        </div>
      </div>
    </section>
  );
}
