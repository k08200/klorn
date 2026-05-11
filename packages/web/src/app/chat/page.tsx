"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { useToast } from "../../components/toast";
import { API_BASE, apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export default function ChatListPage() {
  return (
    <Suspense>
      <NewChatWelcome />
    </Suspense>
  );
}

function NewChatWelcome() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const prefillHandled = useRef(false);

  // Handle ?prefill= parameter
  useEffect(() => {
    if (prefillHandled.current) return;
    const prefill = searchParams.get("prefill");
    if (!prefill) return;
    prefillHandled.current = true;

    (async () => {
      try {
        const conv = await apiFetch<{ id: string }>("/api/chat/conversations", {
          method: "POST",
          body: JSON.stringify({}),
        });
        router.push(`/chat/${conv.id}?prefill=${encodeURIComponent(prefill)}`);
      } catch {
        toast("결정 스레드를 만들지 못했습니다.", "error");
      }
    })();
  }, [searchParams, router, toast]);

  const startChat = async (initialMessage?: string) => {
    try {
      const conv = await apiFetch<{ id: string }>("/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (initialMessage) {
        router.push(`/chat/${conv.id}?prefill=${encodeURIComponent(initialMessage)}`);
      } else {
        router.push(`/chat/${conv.id}`);
      }
    } catch {
      toast("결정 스레드를 만들지 못했습니다.", "error");
    }
  };

  const suggestions = [
    {
      label: "오늘 결정 정리",
      message: "오늘 내가 처리해야 할 결정을 우선순위로 정리해줘.",
      meta: "큐",
    },
    {
      label: "숨은 리스크 찾기",
      message: "메일, 일정, 할 일에서 놓치면 위험한 신호를 찾아줘.",
      meta: "신호",
    },
    {
      label: "미팅 준비",
      message: "오늘 미팅을 보고 준비해야 할 맥락과 질문을 정리해줘.",
      meta: "맥락",
    },
    {
      label: "후속 액션 작성",
      message: "후속 조치가 필요한 스레드를 찾아 다음 액션을 초안으로 만들어줘.",
      meta: "행동",
    },
    {
      label: "집중 시간 확보",
      message: "가장 중요한 일 하나를 골라 집중 시간을 잡는 결정을 만들어줘.",
      meta: "시간",
    },
    {
      label: "운영 규칙 저장",
      message: "내가 EVE의 승인과 자동 실행을 어떻게 다루길 원하는지 기억해줘.",
      meta: "메모리",
    },
  ];

  const { googleConnected } = useAuth();
  const connectUrl = `${API_BASE}/api/auth/google?token=${typeof window !== "undefined" ? localStorage.getItem("eve-token") || "" : ""}`;

  return (
    <div className="flex min-h-full px-4 pb-28 pt-6 md:py-10">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-8 lg:grid-cols-[0.92fr_1.08fr]">
        {googleConnected === false && (
          <a
            href={connectUrl}
            className="lg:col-span-2 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-3 text-left transition hover:bg-amber-500/15"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-amber-300/40 text-sm text-amber-200">
              i
            </span>
            <div>
              <p className="text-sm font-medium text-amber-100">
                Google을 연결하면 판단이 빨라져요
              </p>
              <p className="text-xs text-stone-500">
                Gmail과 Calendar 신호를 연결해 결정 카드, 알림, 일정 준비를 자동으로 구성합니다
              </p>
            </div>
          </a>
        )}
        <section>
          <div className="mb-7">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-300/10 shadow-2xl shadow-amber-950/30">
              <img src="/brand/mark.svg" alt="" className="h-9 w-9" />
            </div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-300/80">
              결정 스레드
            </p>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight text-stone-50 sm:text-5xl">
              오늘의 판단을 하나의 작전 화면으로 여세요.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-stone-500">
              EVE가 흩어진 업무 신호를 읽고, 근거를 모으고, 실행 전 승인 가능한 다음 행동으로
              정리합니다.
            </p>
          </div>

          {/* Quick input */}
          <div className="relative mb-7 max-w-2xl">
            <button
              type="button"
              onClick={() => startChat()}
              className="group w-full rounded-2xl border border-stone-700/60 bg-stone-950/65 px-5 py-4 text-left text-sm text-stone-500 shadow-2xl shadow-black/20 transition hover:border-amber-500/45 hover:bg-stone-900/80"
            >
              <span className="flex items-center justify-between gap-3">
                <span>새 결정 스레드를 열고 맥락, 판단, 다음 행동을 요청하세요...</span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-300 text-stone-950 transition group-hover:bg-amber-200">
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </span>
              </span>
            </button>
          </div>

          {/* Suggestions */}
          <div className="grid gap-2 sm:grid-cols-2">
            {suggestions.map((s) => (
              <button
                key={s.message}
                type="button"
                onClick={() => startChat(s.message)}
                className="group rounded-xl border border-stone-700/45 bg-stone-950/35 px-4 py-3.5 text-left transition hover:border-amber-500/35 hover:bg-amber-500/10"
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-600">
                  {s.meta}
                </p>
                <p className="mt-2 text-[13px] font-medium text-stone-200 transition group-hover:text-white">
                  {s.label}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-stone-600">{s.message}</p>
              </button>
            ))}
          </div>
        </section>

        <section
          className="relative overflow-hidden rounded-2xl border border-stone-700/45 bg-stone-950/55 p-4 shadow-2xl shadow-black/30"
          aria-label="EVE 결정 미리보기"
        >
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/60 to-transparent" />
          <div className="eve-scan-line pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-amber-200/8 to-transparent" />
          <div className="rounded-xl border border-stone-800 bg-[#0b0d10]/90 p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                  오늘의 운영 루프
                </p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-stone-50">
                  승인 전까지 모든 근거를 보이게
                </h2>
              </div>
              <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-xs text-emerald-200">
                준비됨
              </span>
            </div>

            <div className="grid gap-3">
              {[
                ["신호", "투자자 메일", "수정 지표 요청이 내일 미팅과 연결됨"],
                ["맥락", "피치덱 작업", "열린 작업 2개와 답장 지연이 같은 리스크를 가리킴"],
                ["행동", "답장 초안", "오후 3시 전 승인하면 일정과 메일을 함께 정리"],
              ].map(([label, title, body], index) => (
                <div
                  key={label}
                  className="grid gap-3 rounded-lg border border-stone-800 bg-white/[0.025] p-3 sm:grid-cols-[72px_1fr]"
                >
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-stone-500">
                      0{index + 1}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-amber-200">{label}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-stone-100">{title}</h3>
                    <p className="mt-1 text-xs leading-5 text-stone-500">{body}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-lg border border-stone-800 bg-black/25">
              {[
                ["4", "신호"],
                ["2", "리스크"],
                ["1", "승인"],
              ].map(([value, label]) => (
                <div key={label} className="border-r border-stone-800 px-3 py-3 last:border-r-0">
                  <p className="text-xl font-semibold text-stone-50">{value}</p>
                  <p className="mt-1 text-[11px] text-stone-600">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
