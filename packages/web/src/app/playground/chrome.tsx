"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";

export const METHODOLOGY_URL = "https://klorn.ai/methodology/";
const PRICING_URL = "https://klorn.ai/pricing/";
const PRIVACY_URL = "https://klorn.ai/privacy/";
/** Sign-up is direct (no waitlist): the login screen creates the account. */
export const START_URL = "/login";

/** A primary-role link (ui/button has no anchor form). */
export const PRIMARY_LINK =
  "focus-ring inline-flex min-h-9 items-center justify-center rounded-lg bg-accent-solid px-3.5 text-label font-semibold text-accent-solid-ink transition-colors duration-120 ease-fluid hover:bg-accent-solid-hover pointer-coarse:min-h-11 max-md:min-h-11";

const NAV_LINK =
  "focus-ring inline-flex min-h-11 items-center rounded-lg px-3 text-label text-ink-mid transition-colors duration-120 ease-fluid hover:text-ink";

function Mark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-7 place-items-center rounded-control bg-ink text-head font-bold text-surface-panel"
    >
      K
    </span>
  );
}

export function PlaygroundHeader() {
  const { t } = useT();
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-4 py-3 md:px-12">
      <div className="flex items-center gap-3">
        <Link href="/" className="focus-ring flex min-h-11 items-center gap-3 rounded-lg">
          <Mark />
          <span className="hidden text-head text-ink md:inline">Klorn</span>
        </Link>
        <span aria-hidden="true" className="hidden text-ink-dim md:inline">
          /
        </span>
        <span className="text-head font-medium text-ink-soft">{t("playground.brand.section")}</span>
      </div>
      <nav className="flex items-center gap-1">
        <a href={METHODOLOGY_URL} className={`${NAV_LINK} max-md:hidden`}>
          {t("playground.nav.methodology")}
        </a>
        <a href={PRICING_URL} className={`${NAV_LINK} max-md:hidden`}>
          {t("playground.nav.pricing")}
        </a>
        <Link href={START_URL} className={`${NAV_LINK} max-md:hidden`}>
          {t("playground.nav.login")}
        </Link>
        <Link href={START_URL} className={`${PRIMARY_LINK} ml-1`}>
          {t("playground.nav.startFree")}
        </Link>
      </nav>
    </header>
  );
}

/** Phone only: the header drops these links, so they move to the bottom. */
export function PlaygroundFooter() {
  const { t } = useT();
  return (
    <footer className="flex flex-wrap justify-center gap-2 px-4 pb-8 md:hidden">
      <a href={METHODOLOGY_URL} className={NAV_LINK}>
        {t("playground.nav.methodology")}
      </a>
      <a href={PRIVACY_URL} className={NAV_LINK}>
        {t("playground.footer.privacy")}
      </a>
      <Link href={START_URL} className={NAV_LINK}>
        {t("playground.nav.login")}
      </Link>
    </footer>
  );
}
