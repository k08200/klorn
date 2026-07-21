"use client";

function ErrorPage({
  error,
  reset,
}: {
  error: globalThis.Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-col items-center justify-center min-h-[60vh] px-6">
      <p className="mb-4 rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-200">
        Screen paused
      </p>
      <h1 className="text-xl font-semibold mb-2">Something went wrong on this screen.</h1>
      <p className="text-slate-500 text-sm mb-2 text-center max-w-md">
        Reload the latest context and continue from there.
      </p>
      {error.message && (
        <p className="text-xs text-slate-500 mb-6 font-mono bg-slate-50 border border-slate-200 rounded px-3 py-1.5 max-w-md truncate">
          {error.message}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="bg-sky-500 hover:bg-sky-200 text-stone-950 px-5 py-2.5 rounded-lg text-sm font-medium transition"
      >
        Try again
      </button>
    </main>
  );
}

export default ErrorPage;
