"use client";

import type { AuthProviderId } from "@klorn/contract";
import { type MouseEvent, useEffect, useState } from "react";
import { API_BASE } from "../../lib/api";
import { captureFirstTouchAttribution, storedAttribution } from "../../lib/attribution";
import { useT } from "../../lib/i18n";
import { AppleMark, GoogleMark, NaverMark } from "./provider-marks";

/**
 * The OAuth lane of the login page.
 *
 * All providers share ONE surface treatment. The previous page gave Google a
 * filled warm-grey slab and Apple/Naver thin outlines, which read as a ranking
 * we never meant — and stone-* is a warm family inside a cool slate system, so
 * in the dark theme it landed as a glaring near-white block. Uniform rows let
 * the official mark do the identifying, which is also what Google's and
 * Apple's branding guidelines ask for (neutral button, unaltered mark).
 *
 * Google renders unconditionally: it must never be held hostage to the
 * /api/auth/providers probe. Apple and Naver arrive with that response, so
 * they animate open from zero height instead of shoving the email form down
 * a few hundred ms after paint.
 */

/** Order is deliberate: Google first — it is also the Gmail connection. */
const EXTRA_ORDER: readonly AuthProviderId[] = ["apple", "naver"];

// Radius steps down from the card core (16px) so the curves nest instead of
// competing. Press feedback is a scale, not a translate: a 1px nudge reads as
// a rendering glitch at this size, a 1% squash reads as the surface giving.
const ROW_CLASS =
  "flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-line " +
  "bg-surface-raised text-sm font-medium text-ink transition duration-300 ease-fluid " +
  "hover:border-line-strong hover:bg-surface-hover active:scale-[0.99] " +
  "motion-reduce:transition-none motion-reduce:active:scale-100 focus-ring";

interface ProviderButtonsProps {
  /** Extra providers advertised by the server (google is implicit). */
  extraProviders: readonly AuthProviderId[];
  /** True once the providers probe has settled — drives the reveal. */
  resolved: boolean;
  /** Native shell intercepts Google and runs the system-browser flow. */
  onGoogleClick: (e: MouseEvent) => void;
  /** Invite-only deployments relabel Google as the approved-user path. */
  googleLabel?: string;
}

export default function ProviderButtons({
  extraProviders,
  resolved,
  onGoogleClick,
  googleLabel,
}: ProviderButtonsProps) {
  const { t } = useT();
  const extras = EXTRA_ORDER.filter((id) => extraProviders.includes(id));

  // Google's leg leaves our origin, so the captured inflow has to ride the
  // request itself — the server signs it into the OAuth state and stamps it on
  // the account it creates. Read after mount, never during render: localStorage
  // is not available on the server and would desync hydration.
  const [attr, setAttr] = useState<string | null>(null);
  useEffect(() => {
    // React runs child effects before the parent's, so on a first visit this
    // fires before the login page's own capture effect and the store is still
    // empty — every OAuth signup then lands with attribution NULL (0/15 users
    // as of 2026-09-08). Capture is idempotent (first touch wins), so do it
    // here before reading instead of depending on effect order.
    captureFirstTouchAttribution();
    setAttr(storedAttribution());
  }, []);
  const googleHref = attr
    ? `${API_BASE}/api/auth/google/login?attr=${encodeURIComponent(attr)}`
    : `${API_BASE}/api/auth/google/login`;

  return (
    <div>
      <a href={googleHref} onClick={onGoogleClick} className={ROW_CLASS}>
        <GoogleMark />
        {googleLabel ?? t("auth.continueWithGoogle")}
      </a>

      {/* 0fr → 1fr on a grid row is the one height transition that works
          without a hardcoded max-height, so the reveal cannot clip a button
          if a third provider ever lands here. */}
      <div
        className={`grid transition-[grid-template-rows] duration-500 ease-fluid motion-reduce:transition-none ${
          resolved && extras.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 pt-3">
            {extras.map((id) => (
              <a key={id} href={`${API_BASE}/api/auth/${id}/login`} className={ROW_CLASS}>
                {id === "apple" ? <AppleMark /> : <NaverMark />}
                {id === "apple" ? t("auth.continueWithApple") : t("auth.continueWithNaver")}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
