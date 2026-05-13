import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-col items-center justify-center min-h-[60vh] px-6">
      <p className="text-6xl font-bold text-stone-700 mb-4">404</p>
      <h1 className="text-xl font-semibold mb-2">화면을 찾을 수 없어요</h1>
      <p className="text-stone-400 text-sm mb-8 text-center max-w-md">
        이 결정 화면은 사용할 수 없거나 현재 워크스페이스 밖에 있어요.
      </p>
      <div className="flex gap-3">
        <Link
          href="/inbox"
          className="bg-amber-300 hover:bg-amber-200 text-stone-950 px-5 py-2.5 rounded-lg text-sm font-medium transition"
        >
          결정 큐 열기
        </Link>
        <Link
          href="/briefing"
          className="bg-stone-900 hover:bg-stone-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition border border-stone-700"
        >
          일일 브리핑
        </Link>
      </div>
    </main>
  );
}
