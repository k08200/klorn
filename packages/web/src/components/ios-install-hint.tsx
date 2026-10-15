"use client";

import { useEffect, useId, useState } from "react";
import { useT } from "../lib/i18n";
import { IOS_INSTALL_DISMISSED_KEY, shouldOfferIosInstall } from "../lib/ios-install";
import { isNativePlatform } from "../lib/native/capacitor";
import { isNativeShell } from "../lib/native/shell";
import { CloseGlyph } from "./pwa-prompts";
import Button from "./ui/button";

function readDismissedAt(): number {
  try {
    return Number(localStorage.getItem(IOS_INSTALL_DISMISSED_KEY) || 0);
  } catch {
    // Storage blocked (private mode): treat as never dismissed.
    return 0;
  }
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * iPhone home-screen install hint. iOS delivers web push only to an
 * installed web app, so Safari users get manual steps.
 *
 * It is an inline card at the top of the page — in the document flow, so it
 * pushes content down instead of covering it (the old floating card sat over
 * the sign-in form on phones). Shown only in iPhone Safari, never in the
 * native app or an installed web app, and snoozed for a week when dismissed.
 * Phones only (`md:hidden`); the caller decides which pages carry it.
 */
export default function IosInstallHint() {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();

  useEffect(() => {
    setVisible(
      shouldOfferIosInstall({
        userAgent: window.navigator.userAgent,
        standalone: isStandalone(),
        native: isNativePlatform() || isNativeShell(),
        dismissedAt: readDismissedAt(),
        now: Date.now(),
      }),
    );
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(IOS_INSTALL_DISMISSED_KEY, String(Date.now()));
    } catch {
      // Storage blocked: the hint simply returns on the next visit.
    }
  };

  return (
    <section
      aria-label={t("pwa.ios.region")}
      className="mx-4 mt-3 rounded-card border border-line bg-surface-raised p-3 md:hidden"
    >
      <div className="flex items-start gap-3">
        <img src="/brand/mark.svg?v=matte2" alt="" className="mt-0.5 h-8 w-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-label text-ink">{t("pwa.ios.title")}</p>
          <p className="mt-0.5 text-caption text-ink-mid">{t("pwa.ios.body")}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1.5 -mt-1.5"
          aria-label={t("pwa.ios.dismiss")}
          onClick={dismiss}
        >
          <CloseGlyph />
        </Button>
      </div>

      <ol
        id={stepsId}
        hidden={!expanded}
        className="mt-2 space-y-1.5 pl-11 text-caption text-ink-soft"
      >
        <li className="flex items-center gap-1.5">
          <span>1. {t("pwa.ios.step1")}</span>
          <ShareGlyph />
        </li>
        <li>2. {t("pwa.ios.step2")}</li>
        <li>3. {t("pwa.ios.step3")}</li>
      </ol>

      <div className="pl-10">
        <Button
          variant="link"
          size="sm"
          aria-expanded={expanded}
          aria-controls={stepsId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t("pwa.ios.hideSteps") : t("pwa.ios.showSteps")}
        </Button>
      </div>
    </section>
  );
}

/** The iOS share glyph (square with an up arrow), so step 1 matches Safari. */
function ShareGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-accent-deep"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 1.75v8M5.25 4.5 8 1.75l2.75 2.75M5 7H3.75v7.25h8.5V7H11" />
    </svg>
  );
}
