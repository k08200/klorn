import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-line mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-caption text-ink-mid">
          <span>
            <span className="text-accent-deep font-medium">Klorn</span> v0.2.0
          </span>
          <span className="hidden sm:inline text-slate-300">|</span>
          <span className="hidden sm:inline">Decision workspace</span>
        </div>
        <div className="flex items-center gap-3 text-caption text-ink-mid">
          <Link href="/billing" className="hover:text-ink-soft transition-colors">
            Plan
          </Link>
          <Link href="/settings" className="hover:text-ink-soft transition-colors">
            Control plane
          </Link>
          <span className="hidden sm:inline text-slate-300">|</span>
          <span className="hidden sm:inline">Cmd+K to search</span>
        </div>
      </div>
    </footer>
  );
}
