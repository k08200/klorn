import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#ffffff] px-6 text-center text-slate-900">
      <img src="/brand/mark.svg?v=matte2" alt="" className="mb-6 h-10 w-10" />
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-sky-600">
        Page not found
      </p>
      <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
        This workspace view is unavailable.
      </h1>
      <p className="mt-4 max-w-md text-sm leading-6 text-slate-500">
        The link may be old, renamed, or outside your current workspace. Start from the decision
        queue or return to the public overview.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/inbox"
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-sky-500 px-5 text-sm font-semibold text-white transition hover:bg-sky-600"
        >
          Open decision queue
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-200 px-5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
