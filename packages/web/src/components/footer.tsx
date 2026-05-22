import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-stone-800/40 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-[11px] text-stone-600">
          <span>
            <span className="text-amber-300/80 font-medium">Klorn</span> v0.2.0
          </span>
          <span className="hidden sm:inline text-stone-800">|</span>
          <span className="hidden sm:inline">Decision workspace</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-stone-600">
          <Link href="/billing" className="hover:text-stone-400 transition-colors">
            Plan
          </Link>
          <Link href="/settings" className="hover:text-stone-400 transition-colors">
            Control plane
          </Link>
          <span className="hidden sm:inline text-stone-800">|</span>
          <span className="hidden sm:inline">Cmd+K to search</span>
        </div>
      </div>
    </footer>
  );
}
