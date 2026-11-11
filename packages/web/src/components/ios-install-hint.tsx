"use client";

import { Fragment, type ReactNode, useEffect, useId, useState } from "react";
import { useT } from "../lib/i18n";
import { IOS_INSTALL_DISMISSED_KEY, shouldOfferIosInstall } from "../lib/ios-install";
import { isNativePlatform } from "../lib/native/capacitor";
import { isNativeShell } from "../lib/native/shell";
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
 * native app or an installed web app, and snoozed for 14 days on "Not now".
 * Phones only (`md:hidden`); the caller decides which pages carry it.
 */
export default function IosInstallHint() {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  const titleId = useId();

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

  const notNow = () => {
    setVisible(false);
    try {
      localStorage.setItem(IOS_INSTALL_DISMISSED_KEY, String(Date.now()));
    } catch {
      // Storage blocked: the card simply returns on the next visit.
    }
    // The focused button is about to unmount; hand focus to the page.
    document.getElementById("main")?.focus();
  };

  return (
    <section
      aria-labelledby={titleId}
      className="mx-4 mt-3 rounded-card border border-line bg-surface-raised p-4 md:hidden"
    >
      <div className="flex items-start gap-3">
        <img src="/brand/mark.svg?v=matte2" alt="" className="mt-0.5 h-8 w-8 shrink-0" />
        <div className="min-w-0 flex-1">
          {/* Not a heading: the card renders above the page's own h1. */}
          <p id={titleId} className="text-role-label text-ink">
            {t("pwa.ios.title")}
          </p>
          <p className="mt-0.5 text-role-caption text-ink-mid">{t("pwa.ios.body")}</p>
        </div>
      </div>
      <IosHomeScreenSteps className="mt-3 pl-11" />
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" size="lg" onClick={notNow}>
          {t("pwa.ios.notNow")}
        </Button>
      </div>
    </section>
  );
}

/**
 * The three Add-to-Home-Screen steps, numbered, with Safari's own words in
 * bold. Shared by this card and the phone-setup panel in settings.
 */
export function IosHomeScreenSteps({ className = "" }: { className?: string }) {
  const { t } = useT();
  const strong = (key: string) => <strong className="font-semibold text-ink">{t(key)}</strong>;
  const steps = [
    withSlots(t("pwa.ios.step1"), { share: strong("pwa.ios.shareLabel") }, <ShareGlyph />),
    withSlots(t("pwa.ios.step2"), { add: strong("pwa.ios.addLabel") }),
    withSlots(t("pwa.ios.step3"), {}),
  ];
  return (
    <ol className={`space-y-2 text-role-body text-ink-soft ${className}`}>
      {steps.map((content, i) => (
        <li key={STEP_KEYS[i]} className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-line text-role-caption text-ink-mid"
          >
            {i + 1}
          </span>
          <span className="min-w-0 flex-1">{content}</span>
        </li>
      ))}
    </ol>
  );
}

const STEP_KEYS = ["share", "add", "open"] as const;

/** Fill `{slot}` markers in a translated string with elements, so the bold
 *  word can sit wherever each language puts it. */
function withSlots(
  template: string,
  slots: Record<string, ReactNode>,
  trailing?: ReactNode,
): ReactNode {
  const parts = template.split(/\{(\w+)\}/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Fragment key={`s${i}`}>{slots[part] ?? part}</Fragment>
        ) : (
          part && <Fragment key={`t${i}`}>{part}</Fragment>
        ),
      )}
      {trailing ? <span className="ml-1 inline-flex align-text-bottom">{trailing}</span> : null}
    </>
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
