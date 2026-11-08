"use client";

import { useEffect, useId, useReducer, useRef } from "react";
import { useAuth } from "../lib/auth";
import { trapTab } from "../lib/focusable";
import { useT } from "../lib/i18n";
import { bodyScrollLock, isPlainEscape, modalStack } from "../lib/modal-stack";
import {
  answerToPersist,
  autostartPromptReducer,
  escapeEvent,
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
import { useToast } from "./toast";
import Button from "./ui/button";

/**
 * Windows desktop shell only: the one-time "Keep Klorn running in the
 * background?" dialog (decision N5). Start-at-sign-in stays OFF until the user
 * picks "Open at login" here or turns it on in Settings
 * (lib/native/autostart-prompt.ts holds the rules). Renders nothing in a
 * browser or the Capacitor app.
 */
export default function AutostartPrompt() {
  const { token, loading } = useAuth();
  const { t } = useT();
  const { toast } = useToast();
  const titleId = useId();
  const bodyId = useId();
  const [state, dispatch] = useReducer(autostartPromptReducer, IDLE);
  const prevRef = useRef(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const modalTokenRef = useRef<symbol>(Symbol("autostart-prompt"));

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

  const visible = Boolean(token) && promptVisible(state);
  const busy = state.phase === "enabling";

  // Modal while open: focus starts on the primary button, Tab stays inside,
  // Esc answers "Not now" (escapeEvent), focus returns where it was.
  useEffect(() => {
    if (!visible) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>("[data-autostart-primary]")?.focus();
    }, 0);
    const modalToken = modalTokenRef.current;
    modalStack.push(modalToken);
    const releaseScroll = bodyScrollLock.acquire();
    const onKey = (event: KeyboardEvent) => {
      if (!modalStack.isTop(modalToken)) return;
      if (isPlainEscape(event)) {
        event.stopImmediatePropagation();
        const next = escapeEvent(stateRef.current);
        if (next) dispatch(next);
        return;
      }
      trapTab(event, dialogRef.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey, true);
      modalStack.remove(modalToken);
      releaseScroll();
      previousFocusRef.current?.focus();
    };
  }, [visible]);

  // Signed out with the dialog still open: hide it; it returns after sign-in.
  if (!visible) return null;

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
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-sm rounded-sheet border border-line bg-surface-panel p-6 animate-slide-up motion-reduce:animate-none"
      >
        <img src="/brand/mark.svg?v=matte2" alt="" className="mb-3 h-9 w-9" />
        <h2 id={titleId} className="mb-2 font-semibold text-ink">
          {t("desktop.autostart.prompt.title")}
        </h2>
        <p id={bodyId} className="mb-6 text-role-body text-ink-mid">
          {t("desktop.autostart.prompt.body")}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            size="lg"
            onClick={() => dispatch({ type: "decline" })}
            disabled={busy}
          >
            {t("desktop.autostart.prompt.decline")}
          </Button>
          <Button data-autostart-primary size="lg" onClick={accept} loading={busy} disabled={busy}>
            {busy ? t("desktop.autostart.prompt.enabling") : t("desktop.autostart.prompt.accept")}
          </Button>
        </div>
      </div>
    </div>
  );
}
