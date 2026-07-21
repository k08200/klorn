"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useT } from "../lib/i18n";

interface AuthScreenProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  asideTitle?: string;
  asideBody?: string;
  asideItems?: Array<{ label: string; value: string }>;
  footer?: ReactNode;
  navCtaHref?: string;
  navCtaLabel?: string;
}

export default function AuthScreen({
  eyebrow,
  title,
  description,
  children,
  asideTitle,
  asideBody,
  asideItems,
  footer,
  navCtaHref = "/early-access",
  navCtaLabel,
}: AuthScreenProps) {
  const { t } = useT();
  // Callers may override the marketing aside (e.g. early-access); otherwise
  // fall back to the translated defaults so the panel matches the app locale.
  const resolvedAsideTitle = asideTitle ?? t("auth.asideTitle");
  const resolvedAsideBody = asideBody ?? t("auth.asideBody");
  const resolvedAsideItems = asideItems ?? [
    { label: t("auth.stepSignal"), value: t("auth.stepSignalDesc") },
    { label: t("auth.stepContext"), value: t("auth.stepContextDesc") },
    { label: t("auth.stepApproval"), value: t("auth.stepApprovalDesc") },
  ];
  const resolvedNavCtaLabel = navCtaLabel ?? t("nav.earlyAccess");
  return (
    <main id="main" className="min-h-screen overflow-x-hidden sky-bg text-slate-900">
      <nav className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-8 w-8" />
          <span className="text-sm font-semibold tracking-[0.14em] text-slate-900">Klorn</span>
        </Link>
        {/* Landing nav (Home / Early access) is noise on the app login —
            hide it on phones; the logo stays. */}
        <div className="hidden items-center gap-3 text-sm sm:flex">
          <Link
            className="inline-flex min-h-11 items-center whitespace-nowrap text-slate-500 transition hover:text-slate-900"
            href="/"
          >
            {t("nav.home")}
          </Link>
          <Link
            className="inline-flex min-h-11 items-center whitespace-nowrap rounded-md border border-slate-200 px-3 py-2 text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
            href={navCtaHref}
          >
            {resolvedNavCtaLabel}
          </Link>
        </div>
      </nav>

      <section className="relative z-10 mx-auto grid min-h-[calc(100svh-76px)] max-w-6xl items-start gap-8 px-5 pb-16 pt-6 sm:px-6 lg:grid-cols-[1fr_0.9fr] lg:items-center">
        <aside className="hidden lg:block">
          <div className="max-w-xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {t("nav.decisionQueue")}
            </p>
            <h2 className="mt-4 text-5xl font-semibold leading-[1.02] tracking-tight text-slate-900">
              {resolvedAsideTitle}
            </h2>
            <p className="mt-5 max-w-lg text-base leading-7 text-slate-500">{resolvedAsideBody}</p>
          </div>
          <div className="mt-9 max-w-xl overflow-hidden rounded-lg border border-slate-200 bg-surface-panel">
            {resolvedAsideItems.map((item, index) => (
              <div
                key={item.label}
                className="grid grid-cols-[72px_1fr] gap-4 border-b border-slate-200 px-4 py-4 last:border-b-0"
              >
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
                    0{index + 1}
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-900">{item.label}</p>
                </div>
                <p className="text-sm leading-6 text-slate-500">{item.value}</p>
              </div>
            ))}
          </div>
        </aside>

        <div className="mx-auto w-full max-w-md">
          <div className="mb-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">{description}</p>
          </div>

          {/* Condensed reassurance for mobile + WebView users — the full <aside>
              is hidden below lg, so surface the same three signals compactly
              above the form so phone visitors still get context. */}
          <div className="mb-5 overflow-hidden rounded-lg border border-slate-200 bg-surface-panel lg:hidden">
            <p className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-900">
              {resolvedAsideTitle}
            </p>
            <ul className="divide-y divide-slate-200">
              {resolvedAsideItems.map((item) => (
                <li key={item.label} className="flex gap-3 px-4 py-2.5">
                  <span className="shrink-0 text-xs font-medium text-slate-500">{item.label}</span>
                  <span className="text-xs leading-5 text-slate-500">{item.value}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-slate-200 bg-surface-panel p-4 shadow-xl shadow-black/20 sm:p-5">
            {children}
          </div>

          {footer && <div className="mt-5 text-center text-xs text-slate-400">{footer}</div>}
        </div>
      </section>
    </main>
  );
}
