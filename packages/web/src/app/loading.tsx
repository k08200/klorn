export default function Loading() {
  return (
    <main
      className="flex items-center justify-center min-h-[60vh]"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="w-2.5 h-2.5 bg-sky-500 rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-2.5 h-2.5 bg-sky-500 rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-2.5 h-2.5 bg-sky-500 rounded-full animate-bounce [animation-delay:300ms]" />
        </div>
        <p className="text-sm text-slate-400">Preparing context...</p>
      </div>
    </main>
  );
}
