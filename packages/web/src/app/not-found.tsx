import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-app px-6 text-center text-ink">
      <img src="/brand/mark.svg?v=matte2" alt="" className="mb-6 h-10 w-10" />
      <p className="mb-3 font-mono text-caption uppercase tracking-[0.18em] text-accent-deep">
        Page not found
      </p>
      <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
        This workspace view is unavailable.
      </h1>
      <p className="mt-4 max-w-md text-sm leading-6 text-ink-mid">
        The link may be old, renamed, or outside your current workspace. Open Klorn to pick up where
        you left off.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent-solid px-5 text-sm font-semibold text-accent-solid-ink transition hover:bg-accent-solid-hover"
        >
          Open Klorn
        </Link>
        <a
          href="https://klorn.ai"
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-line px-5 text-sm font-medium text-ink-mid transition hover:bg-surface-hover hover:text-ink"
        >
          About Klorn
        </a>
      </div>
    </main>
  );
}
