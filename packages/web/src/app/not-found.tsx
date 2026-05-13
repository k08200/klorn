import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-col items-center justify-center min-h-[60vh] px-6">
      <p className="text-6xl font-bold text-stone-700 mb-4">404</p>
      <h1 className="text-xl font-semibold mb-2">Page not found</h1>
      <p className="text-stone-400 text-sm mb-8 text-center max-w-md">
        This decision view is unavailable or outside your current workspace.
      </p>
      <div className="flex gap-3">
        <Link
          href="/inbox"
          className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-5 py-2.5 rounded-lg text-sm font-medium transition"
        >
          Open decision queue
        </Link>
        <Link
          href="/briefing"
          className="bg-stone-900 hover:bg-stone-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition border border-stone-700"
        >
          Daily briefing
        </Link>
      </div>
    </main>
  );
}
