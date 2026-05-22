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
        toast("Could not create a decision thread.", "error");
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
      toast("Could not create a decision thread.", "error");
    }
  };

  const suggestions = [
    {
      label: "Prioritize today",
      message:
        "Review today's mail, meetings, and tasks, then rank the decisions I should handle first.",
      meta: "Queue",
    },
    {
      label: "Find hidden risks",
      message: "Find mail, calendar, or task items that could become urgent or blocked.",
      meta: "Signal",
    },
    {
      label: "Prep meetings",
      message: "Review today's meetings and list the context, questions, and follow-ups I need.",
      meta: "Context",
    },
    {
      label: "Draft follow-ups",
      message: "Find threads that need follow-up and draft the next action.",
      meta: "Action",
    },
    {
      label: "Protect focus time",
      message: "Pick the most important work and suggest focus blocks around my current schedule.",
      meta: "Time",
    },
    {
      label: "Save operating rules",
      message: "Remember how my workspace should handle approvals, automation, and risky actions.",
      meta: "Memory",
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
                Connect Google for better context
              </p>
              <p className="text-xs text-stone-500">
                Turn Gmail and Calendar signals into decision cards, reminders, and meeting prep.
              </p>
            </div>
          </a>
        )}
        <section>
          <div className="mb-7">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg border border-stone-800 bg-[#111318]">
              <img src="/brand/mark.svg?v=flow-5" alt="" className="h-9 w-9" />
            </div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              New thread
            </p>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight text-stone-50 sm:text-5xl">
              Start with the decision in front of you.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-stone-500">
              Ask Klorn to connect the relevant mail, meetings, tasks, and next actions.
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
                <span>Create a blank decision thread</span>
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
