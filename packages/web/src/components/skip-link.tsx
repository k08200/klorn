"use client";

import { useT } from "../lib/i18n";

/**
 * Skip link (WCAG 2.4.1): the first focusable element on every route, hidden
 * until a keyboard user tabs to it. One instance for the whole app — the app
 * shell used to render a second one after the root layout's English-only
 * copy, so keyboard users met two skip links and Korean users an English one.
 * Every surface marks its content container with id="main".
 */
export default function SkipLink() {
  const { t } = useT();
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-accent-solid px-4 py-2 text-sm font-semibold text-accent-solid-ink focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:z-[200] focus-ring"
    >
      {t("appShell.skipToContent")}
    </a>
  );
}
