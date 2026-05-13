export default function Loading() {
  return (
    <main className="flex items-center justify-center min-h-[60vh]">
      <div className="flex flex-col items-center gap-3">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 bg-amber-300 rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-2.5 h-2.5 bg-amber-300 rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-2.5 h-2.5 bg-amber-300 rounded-full animate-bounce [animation-delay:300ms]" />
        </div>
        <p className="text-sm text-stone-500">맥락을 준비하는 중...</p>
      </div>
    </main>
  );
}
