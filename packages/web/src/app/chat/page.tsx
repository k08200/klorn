"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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
        toast("Failed to create conversation", "error");
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
      toast("Failed to create conversation", "error");
    }
  };

  const suggestions = [
    {
      label: "Clear decisions",
      message: "Show me the decisions I should clear today.",
      meta: "queue",
    },
    {
      label: "Find hidden risk",
      message: "Look across email, calendar, and tasks for anything at risk.",
      meta: "signals",
    },
    {
      label: "Prepare meetings",
      message: "Review today's meetings and tell me what needs prep.",
      meta: "context",
    },
    {
      label: "Draft follow-up",
      message: "Find a thread that needs a follow-up and draft the next move.",
      meta: "move",
    },
    {
      label: "Protect focus",
      message: "Find one important task and block time for it.",
      meta: "calendar",
    },
    {
      label: "Update memory",
      message: "Remember how I want EVE to handle approvals.",
      meta: "memory",
    },
  ];

  const { googleConnected } = useAuth();
  const connectUrl = `${API_BASE}/api/auth/google?token=${typeof window !== "undefined" ? localStorage.getItem("eve-token") || "" : ""}`;

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 pb-28 pt-10 md:py-10">
      <div className="w-full max-w-4xl">
        {googleConnected === false && (
          <a
            href={connectUrl}
            className="mx-auto mb-6 flex max-w-md items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-3 text-left transition hover:bg-amber-500/15"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-amber-300/40 text-sm text-amber-200">
              i
            </span>
            <div>
              <p className="text-sm font-medium text-amber-100">Connect Google to get started</p>
              <p className="text-xs text-stone-500">
                Link Gmail & Calendar for email sync, notifications, and scheduling
              </p>
            </div>
          </a>
        )}
        <div className="mb-8 text-center">
          <img src="/brand/mark.svg" alt="" className="mx-auto mb-4 h-14 w-14" />
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-300/80">
            Command Console
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-stone-50 sm:text-4xl">
            Turn the work stream into decisions.
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-stone-500">
            Ask EVE to inspect signals, assemble context, draft the move, or prepare a decision card
            before anything gets executed.
          </p>
        </div>

        {/* Quick input */}
        <div className="relative mx-auto mb-7 max-w-2xl">
          <button
            type="button"
            onClick={() => startChat()}
            className="group w-full rounded-2xl border border-stone-700/60 bg-stone-950/55 px-5 py-4 text-left text-sm text-stone-500 shadow-2xl shadow-black/20 transition hover:border-amber-500/45 hover:bg-stone-900/80"
          >
            <span className="flex items-center justify-between gap-3">
              <span>Ask EVE to build a decision, brief, or next move...</span>
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
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
      </div>
    </div>
  );
}
