"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import AuthGuard from "../../components/auth-guard";
import { useToast } from "../../components/toast";
import { API_BASE, apiFetch, getStoredAuthToken } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export default function ChatListPage() {
  return (
    <AuthGuard>
      <Suspense>
        <NewChatWelcome />
      </Suspense>
    </AuthGuard>
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
        toast("결정 스레드를 만들지 못했어요.", "error");
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
      toast("결정 스레드를 만들지 못했어요.", "error");
    }
  };

  const suggestions = [
    {
      label: "오늘 결정할 일 정리",
      message: "오늘 내가 처리해야 할 결정을 우선순위로 정리해줘.",
      meta: "결정함",
    },
    {
      label: "숨은 리스크 찾기",
      message: "메일, 캘린더, 작업에서 위험 신호를 찾아줘.",
      meta: "신호",
    },
    {
      label: "미팅 준비",
      message: "오늘 미팅을 훑고 필요한 맥락과 질문을 준비해줘.",
      meta: "맥락",
    },
    {
      label: "후속 조치 초안",
      message: "후속 조치가 필요한 스레드를 찾고 다음 액션을 써줘.",
      meta: "액션",
    },
    {
      label: "집중 시간 확보",
      message: "가장 중요한 일을 고르고 집중 블록을 제안해줘.",
      meta: "시간",
    },
    {
      label: "작동 규칙 저장",
      message: "승인과 자동화를 Jigeum이 어떻게 다뤄야 하는지 기억해줘.",
      meta: "메모리",
    },
  ];

  const { googleConnected } = useAuth();
  const connectUrl = `${API_BASE}/api/auth/google?token=${getStoredAuthToken() || ""}`;

  return (
    <div className="flex min-h-full px-4 pb-28 pt-6 md:py-10">
      <div className="mx-auto w-full max-w-4xl">
        {googleConnected === false && (
          <a
            href={connectUrl}
            className="mx-auto mb-8 flex max-w-md items-center gap-3 rounded-lg border border-stone-700 bg-[#111318] px-5 py-3 text-left transition hover:bg-stone-900"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-stone-600 text-sm text-stone-300">
              i
            </span>
            <div>
              <p className="text-sm font-medium text-stone-100">
                더 좋은 맥락을 위해 Google 연결
              </p>
              <p className="text-xs text-stone-500">
                Jigeum이 Gmail과 캘린더를 바탕으로 결정 카드, 알림, 미팅 준비를 도와요.
              </p>
            </div>
          </a>
        )}
        <section>
          <div className="mb-7">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg border border-stone-800 bg-[#111318]">
              <img src="/brand/mark.svg" alt="" className="h-9 w-9" />
            </div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              새 스레드
            </p>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight text-stone-50 sm:text-5xl">
              지금 필요한 결정을 바로 시작하세요.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-stone-500">
              관련 메일, 미팅, 작업, 다음 액션을 Jigeum에게 한 번에 연결해달라고 요청하세요.
            </p>
          </div>

          {/* Quick input */}
          <div className="relative mb-7 max-w-2xl">
            <button
              type="button"
              onClick={() => startChat()}
              className="group relative w-full rounded-lg border border-stone-700 bg-[#111318] px-5 py-4 text-left text-sm text-stone-500 shadow-xl shadow-black/10 transition hover:border-stone-600 hover:bg-stone-900"
            >
              <span className="flex items-center justify-between gap-3">
                <span>스레드를 열고 맥락, 판단, 다음 액션을 요청하세요...</span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-950 transition group-hover:bg-white">
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
                className="group rounded-lg border border-stone-800 bg-[#111318] px-4 py-3.5 text-left transition hover:border-stone-700 hover:bg-stone-900"
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
      </div>
    </div>
  );
}
