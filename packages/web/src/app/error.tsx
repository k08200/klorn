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
        화면을 멈췄어요
      </p>
      <h1 className="text-xl font-semibold mb-2">이 작업 화면에서 문제가 생겼어요.</h1>
      <p className="text-stone-400 text-sm mb-2 text-center max-w-md">
        최신 맥락을 다시 불러온 뒤 이어서 진행할 수 있어요.
      </p>
      {error.message && (
        <p className="text-xs text-stone-600 mb-6 font-mono bg-stone-950 border border-stone-800 rounded px-3 py-1.5 max-w-md truncate">
          {error.message}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-5 py-2.5 rounded-lg text-sm font-medium transition"
      >
        다시 시도
      </button>
    </main>
  );
}

export default ErrorPage;
