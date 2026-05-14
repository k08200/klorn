"use client";

import Link from "next/link";
import type { ReactNode } from "react";

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
  asideTitle = "Keep only the work that needs a decision",
  asideBody = "Jigeum reads mail, calendar, and task signals, then turns them into cards you can review before anything runs.",
  asideItems = [
    { label: "Signal", value: "Detect meaningful changes in mail and calendar" },
    { label: "Context", value: "Connect people, deadlines, and projects" },
    { label: "Approval", value: "Review evidence before external execution" },
  ],
  footer,
  navCtaHref = "/early-access",
  navCtaLabel = "Early access",
}: AuthScreenProps) {
  return (
    <main className="min-h-screen overflow-x-hidden bg-[#0f1115] text-stone-50">
      <nav className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <img src="/brand/mark.svg?v=flow-5" alt="" className="h-8 w-8" />
          <span className="text-sm font-semibold tracking-[0.14em] text-stone-100">Jigeum</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <Link
            className="inline-flex min-h-11 items-center whitespace-nowrap text-stone-400 transition hover:text-stone-100"
            href="/"
          >
            Home
          </Link>
          <Link
            className="inline-flex min-h-11 items-center whitespace-nowrap rounded-md border border-stone-700 px-3 py-2 text-stone-300 transition hover:border-stone-500 hover:text-stone-100"
            href={navCtaHref}
          >
            {navCtaLabel}
          </Link>
        </div>
      </nav>

      <section className="relative z-10 mx-auto grid min-h-[calc(100svh-76px)] max-w-6xl items-start gap-8 px-5 pb-16 pt-6 sm:px-6 lg:grid-cols-[1fr_0.9fr] lg:items-center">
        <aside className="hidden lg:block">
          <div className="max-w-xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Decision queue
            </p>
            <h2 className="mt-4 text-5xl font-semibold leading-[1.02] tracking-tight text-white">
              {asideTitle}
            </h2>
            <p className="mt-5 max-w-lg text-base leading-7 text-stone-400">{asideBody}</p>
          </div>
          <div className="mt-9 max-w-xl overflow-hidden rounded-lg border border-stone-800 bg-[#111318]">
            {asideItems.map((item, index) => (
              <div
                key={item.label}
                className="grid grid-cols-[72px_1fr] gap-4 border-b border-stone-800 px-4 py-4 last:border-b-0"
              >
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-stone-600">
                    0{index + 1}
                  </p>
                  <p className="mt-1 text-sm font-medium text-stone-200">{item.label}</p>
                </div>
                <p className="text-sm leading-6 text-stone-300">{item.value}</p>
              </div>
            ))}
          </div>
        </aside>

        <div className="mx-auto w-full max-w-md">
          <div className="mb-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-stone-400">{description}</p>
          </div>

          <div className="rounded-lg border border-stone-800 bg-[#111318] p-4 shadow-xl shadow-black/20 sm:p-5">
            {children}
          </div>

          {footer && <div className="mt-5 text-center text-xs text-stone-500">{footer}</div>}
        </div>
      </section>
    </main>
  );
}
