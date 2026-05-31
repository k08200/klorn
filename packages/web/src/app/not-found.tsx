import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0f1115] px-6 text-center text-stone-100">
      <img src="/brand/mark.svg?v=navy1" alt="" className="mb-6 h-10 w-10" />
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-amber-300">
        Page not found
      </p>
      <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
        This workspace view is unavailable.
      </h1>
      <p className="mt-4 max-w-md text-sm leading-6 text-stone-400">
        The link may be old, renamed, or outside your current workspace. Start from the decision
        queue or return to the public overview.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/inbox"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-amber-300 px-5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
        >
          Open decision queue
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-stone-700 px-5 text-sm font-medium text-stone-300 transition hover:bg-stone-900 hover:text-white"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
