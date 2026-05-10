"use client";

import Link from "next/link";
import { useState } from "react";
import { API_BASE } from "@/lib/api";

type Status = "idle" | "submitting" | "success" | "already" | "error";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/;

export default function EarlyAccessPage() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) {
      setErrorMsg("이메일 형식이 올바르지 않아요.");
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch(`${API_BASE}/api/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cleanEmail,
          name: name.trim() || undefined,
          useCase: useCase.trim() || undefined,
        }),
      });

      if (res.status === 429) {
        setStatus("error");
        setErrorMsg("요청이 너무 잦아요. 잠시 후 다시 시도해주세요.");
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setErrorMsg(body.error || "문제가 생겼어요. 잠시 후 다시 시도해주세요.");
        return;
      }

      const body = (await res.json()) as { ok: boolean; alreadyOnList?: boolean };
      setStatus(body.alreadyOnList ? "already" : "success");
    } catch (_err) {
      setStatus("error");
      setErrorMsg("네트워크 오류예요. 잠시 후 다시 시도해주세요.");
    }
  };

  const isDone = status === "success" || status === "already";

  return (
    <main className="min-h-screen bg-[#10100d] text-stone-50">
      <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-300 text-sm font-bold text-stone-950">
            E
          </div>
          <span className="text-lg font-bold tracking-tight">EVE</span>
        </Link>
        <div className="flex items-center gap-5 text-sm text-stone-400">
          <Link href="/privacy" className="transition hover:text-white">
            Privacy
          </Link>
          <Link href="/terms" className="transition hover:text-white">
            Terms
          </Link>
          <Link href="/login" className="transition hover:text-white">
            Sign in
          </Link>
        </div>
      </nav>

      <section className="mx-auto max-w-2xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-200">
          Early Access
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">
          매일 흩어진 일을 결정 가능한 신호로 정리하는 Decision OS
        </h1>
        <p className="mt-5 text-base leading-7 text-stone-400">
          EVE는 비공개 베타입니다. 메일/캘린더 사용량이 많은 분들에게 우선 초대합니다. 신청하시면
          24시간 안에 확인하고 메일로 답변드릴게요.
        </p>

        {isDone ? (
          <div className="mt-10 rounded-xl border border-amber-300/30 bg-amber-300/10 p-6">
            <h2 className="text-lg font-semibold text-white">
              {status === "already" ? "이미 신청해주셨어요" : "신청 완료"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-stone-300">
              {status === "already"
                ? "기존 신청을 기준으로 검토 후 메일로 답변드릴게요."
                : "검토 후 24시간 안에 메일로 답변드릴게요. 메일이 도착하면 EVE에 로그인하실 수 있어요."}
            </p>
            <div className="mt-6 flex flex-wrap gap-3 text-sm">
              <Link
                href="/"
                className="rounded-lg border border-stone-700 px-4 py-2 text-stone-300 transition hover:bg-stone-900"
              >
                홈으로
              </Link>
              <Link
                href="/privacy"
                className="rounded-lg border border-stone-700 px-4 py-2 text-stone-300 transition hover:bg-stone-900"
              >
                Privacy 보기
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-10 space-y-5" noValidate>
            <div>
              <label className="block text-sm font-medium text-stone-200" htmlFor="email">
                이메일 (필수)
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-2 w-full rounded-lg border border-stone-700 bg-stone-950/35 px-3 py-2 text-sm text-white outline-none focus:border-amber-300"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-200" htmlFor="name">
                이름 (선택)
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                className="mt-2 w-full rounded-lg border border-stone-700 bg-stone-950/35 px-3 py-2 text-sm text-white outline-none focus:border-amber-300"
                placeholder="홍길동"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-200" htmlFor="useCase">
                평소 메일을 어떻게 쓰세요? (선택, 한 줄)
              </label>
              <input
                id="useCase"
                type="text"
                value={useCase}
                onChange={(e) => setUseCase(e.target.value)}
                maxLength={500}
                className="mt-2 w-full rounded-lg border border-stone-700 bg-stone-950/35 px-3 py-2 text-sm text-white outline-none focus:border-amber-300"
                placeholder="예: 하루 메일 50통+, 일정과 후속 조치가 흩어져 우선순위 결정이 어려움"
              />
              <p className="mt-2 text-xs text-stone-500">
                메일/캘린더 사용 패턴이 베타에 잘 맞을지 보는 용도예요.
              </p>
            </div>

            {errorMsg && (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {errorMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={status === "submitting"}
              className="rounded-lg bg-amber-300 px-5 py-2.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:opacity-60"
            >
              {status === "submitting" ? "신청 중…" : "Early Access 신청하기"}
            </button>

            <p className="text-xs leading-5 text-stone-500">
              신청 시{" "}
              <Link href="/privacy" className="underline hover:text-stone-300">
                Privacy Policy
              </Link>
              와{" "}
              <Link href="/terms" className="underline hover:text-stone-300">
                Terms
              </Link>
              에 동의한 것으로 간주됩니다. 베타는 메일/캘린더 데이터를 처리합니다.
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
