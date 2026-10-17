/**
 * The app while the session is checked (design detail pass W9): the shell
 * itself — sidebar, page title, three row cards — drawn as placeholders where
 * the loaded page will put them, instead of a centred "Checking session…"
 * splash. One K mark, in the same place as the sidebar's. The status is
 * spoken once; the shapes are hidden from assistive tech.
 */

import { PAGE_SHELL } from "./page-shell";
import { MailRowSkeleton } from "./ui/skeleton";

const SHAPE = "bg-surface-inset motion-safe:animate-pulse";
const NAV_ROWS = ["a", "b", "c", "d", "e"];
const CARDS = ["a", "b", "c"];

export default function ShellSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-dvh overflow-hidden bg-surface-panel" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <aside
        aria-hidden="true"
        className="hidden h-dvh w-[260px] shrink-0 flex-col gap-1 border-r border-line/70 px-3 py-4 md:flex"
      >
        <div className="flex items-center gap-2.5 px-1 pb-5">
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-8 w-8" />
          <div className={`${SHAPE} h-3.5 w-14 rounded-control`} />
        </div>
        {NAV_ROWS.map((key) => (
          <div key={key} className="flex h-10 items-center gap-3 px-3">
            <div className={`${SHAPE} size-4 rounded-control`} />
            <div className={`${SHAPE} h-3 w-20 rounded-control`} />
          </div>
        ))}
      </aside>
      <div aria-hidden="true" className="min-w-0 flex-1 overflow-hidden bg-surface-app">
        <div className="flex h-12 items-center gap-3 border-b border-line bg-surface-panel px-4 md:hidden">
          <img src="/brand/mark.svg?v=matte2" alt="" className="h-6 w-6" />
          <div className={`${SHAPE} h-3 w-12 rounded-control`} />
        </div>
        <div className={`${PAGE_SHELL} flex flex-col gap-7`}>
          <div className="flex flex-col gap-2">
            <div className={`${SHAPE} h-7 w-40 rounded-control`} />
            <div className={`${SHAPE} h-3 w-64 max-w-full rounded-control opacity-60`} />
          </div>
          {CARDS.map((key) => (
            <div key={key} className="flex flex-col gap-2.5">
              <div className={`${SHAPE} h-5.5 w-20 rounded-control`} />
              <div className="divide-y divide-line-soft overflow-hidden rounded-xl bg-surface-panel ring-1 ring-line">
                <MailRowSkeleton />
                <MailRowSkeleton />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
