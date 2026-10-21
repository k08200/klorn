"use client";

import { useT } from "../lib/i18n";

/**
 * Route error boundary (design detail pass W9): anchored 96px from the top
 * like the loading and empty states, in the UI language. The thrown message
 * is developer text (often English, sometimes internal), so it is never shown;
 * the digest is the reference that matches the server log.
 */
function ErrorPage({
  error,
  reset,
}: {
  error: globalThis.Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useT();
  return (
    <main className="flex flex-col items-center px-6 pb-12 pt-24 text-center">
      <p className="mb-4 rounded-full border border-state-danger-line bg-state-danger-bg px-3 py-1 text-caption font-semibold text-state-danger-ink">
        {t("statePage.error.eyebrow")}
      </p>
      <h1 className="text-title text-ink [word-break:keep-all]">{t("statePage.error.title")}</h1>
      <p className="mt-1 max-w-md text-body text-ink-mid [word-break:keep-all]">
        {t("statePage.error.body")}
      </p>
      {error.digest && (
        <p className="mt-3 font-mono text-caption text-ink-mid">
          {t("statePage.error.reference", { digest: error.digest })}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-accent-solid px-5 text-sm font-medium text-accent-solid-ink transition hover:bg-accent-solid-hover focus-ring"
      >
        {t("common.tryAgain")}
      </button>
    </main>
  );
}

export default ErrorPage;
