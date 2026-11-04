"use client";

import Link from "next/link";
import { useT } from "../lib/i18n";

/** 404 (design detail pass W9): anchored 96px from the top, in the UI language. */
export default function NotFound() {
  const { t } = useT();
  return (
    <main className="flex min-h-screen flex-col items-center bg-surface-app px-6 pb-12 pt-24 text-center text-ink">
      <img src="/brand/mark.svg?v=matte2" alt="" className="mb-6 h-10 w-10" />
      <p className="mb-3 font-mono text-caption uppercase tracking-[0.18em] text-accent-deep [&:is(:lang(ko),:lang(ja),:lang(zh))]:tracking-normal">
        {t("statePage.notFound.eyebrow")}
      </p>
      <h1 className="text-role-page [word-break:keep-all]">{t("statePage.notFound.title")}</h1>
      <p className="mt-4 max-w-md text-role-body leading-6 text-ink-mid [word-break:keep-all]">
        {t("statePage.notFound.body")}
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-control bg-accent-solid px-5 text-role-label font-semibold text-accent-solid-ink transition hover:bg-accent-solid-hover"
        >
          {t("statePage.notFound.open")}
        </Link>
        <a
          href="https://klorn.ai"
          className="inline-flex min-h-11 items-center justify-center rounded-control border border-line px-5 text-role-label text-ink-mid transition hover:bg-surface-hover hover:text-ink"
        >
          {t("statePage.notFound.about")}
        </a>
      </div>
    </main>
  );
}
