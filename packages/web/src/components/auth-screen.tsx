"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { accentSerif } from "../lib/fonts/accent-serif";
import { useT } from "../lib/i18n";

/** Published facts behind the trust line live here; the line links to them. */
const SECURITY_URL = "https://klorn.ai/security/";

/** Locales whose script the accent serif covers (it ships a Latin subset). */
const SERIF_LOCALES = new Set(["en", "de", "fr", "es"]);

interface AuthScreenProps {
  /** The page's h1 — a string, or <BrandHeadline /> on the sign-in page. */
  title: ReactNode;
  description?: string;
  children: ReactNode;
  /**
   * Wide-screen product panel (lg and up). Omitted on the secondary flows
   * (reset, verify), which centre a single column instead.
   */
  preview?: ReactNode;
}

/** Entry stagger: two beats, under 200ms in total — this is a task surface. */
const STEP_MS = 80;
const rise = (step: number) => ({ animationDelay: `${step * STEP_MS}ms` });

/**
 * The shell every sign-in surface shares: brand mark, one column holding the
 * task, a quiet footer, and — on the sign-in page at desktop width — a panel
 * showing the product itself. Flat hue-free canvas (productization plan §2);
 * the old landing-sky wash and marketing aside are gone.
 */
export default function AuthScreen({ title, description, children, preview }: AuthScreenProps) {
  return (
    <main
      id="main"
      className={`grid min-h-dvh bg-surface-panel text-ink ${
        preview ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" : ""
      }`}
    >
      <div className="flex min-h-dvh min-w-0 flex-col px-4 pt-safe sm:px-8">
        <header className="flex h-16 shrink-0 items-center">
          <Link
            href="/"
            className="focus-ring -mx-2 inline-flex min-h-11 items-center gap-2.5 rounded-control px-2"
          >
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-7 w-7" />
            <span className="text-head text-ink">Klorn</span>
          </Link>
        </header>

        <div className="flex flex-1 items-start justify-center py-6 sm:items-center sm:py-8">
          <div className="w-full max-w-sm">
            <div className="rise" style={rise(0)}>
              <h1 className="text-display text-balance text-ink">{title}</h1>
              {description && (
                <p className="mt-3 text-body text-pretty text-ink-mid">{description}</p>
              )}
            </div>
            <div className="rise mt-8" style={rise(1)}>
              {children}
            </div>
          </div>
        </div>

        <AuthFooter />
      </div>

      {preview && (
        <aside className="hidden min-w-0 items-center justify-center border-l border-line bg-surface-app px-12 py-16 lg:flex xl:px-20">
          {preview}
        </aside>
      )}
    </main>
  );
}

/**
 * "All your mail and calendars, in one calm place." — the landing's promise,
 * with its serif accent. CJK locales keep the UI face for the accent, as the
 * landing does: the serif has no glyphs for them and a synthetic italic of a
 * fallback font reads as a rendering bug.
 */
export function BrandHeadline() {
  const { t, locale } = useT();
  const accentFace = SERIF_LOCALES.has(locale) ? `${accentSerif.className} font-normal` : "";
  return (
    <>
      {t("auth.headline")}{" "}
      <span className={`block text-accent-deep ${accentFace}`}>{t("auth.headlineAccent")}</span>
    </>
  );
}

function AuthFooter() {
  const { t } = useT();
  const linkClass =
    "focus-ring inline-flex min-h-11 items-center rounded-control text-ink-mid transition-colors duration-120 ease-fluid hover:text-ink";
  return (
    <footer className="flex shrink-0 flex-col gap-1 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 text-caption text-ink-mid sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <a
        href={SECURITY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`${linkClass} text-pretty underline decoration-line-strong underline-offset-2`}
      >
        {t("auth.trustLine")}
      </a>
      <nav aria-label={t("auth.legalNav")} className="flex shrink-0 items-center gap-4">
        <Link href="/privacy" className={linkClass}>
          {t("auth.privacy")}
        </Link>
        <Link href="/terms" className={linkClass}>
          {t("auth.terms")}
        </Link>
      </nav>
    </footer>
  );
}
