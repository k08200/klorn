"use client";

// Assistant chat — the user-facing conversational surface, scoped to Klorn
// data (mail / calendar / briefing) by the server-side chat engine. Calendar
// drafts render as confirm cards (EventDraftCard); the save stays on the
// Pro-gated POST /api/calendar.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import EventDraftCard, { type EventDraft } from "../../components/event-draft-card";
import VoiceButton from "../../components/voice-button";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface ChatMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  metadata: { eventDraft?: EventDraft; turnError?: string } | null;
  createdAt: string;
}

interface TurnResponse {
  reply: string;
  eventDraft: EventDraft | null;
  error?: string;
}

// Suggestion labels resolve via t() inside the component.
const SUGGESTION_KEYS = [
  "chat.suggestion1",
  "chat.suggestion2",
  "chat.suggestion3",
  "chat.suggestion4",
];

export default function ChatPage() {
  return (
    <AuthGuard>
      <ChatView />
    </AuthGuard>
  );
}

function ChatView() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  // Optimistic echo of the user's message while the turn is in flight.
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const conversationsQuery = useQuery({
    queryKey: queryKeys.chat.conversations(),
    queryFn: () => apiFetch<{ conversations: ConversationSummary[] }>("/api/chat/conversations"),
  });

  // Latest conversation resumes by default; "New chat" resets to null.
  const activeId = conversationId ?? conversationsQuery.data?.conversations[0]?.id ?? null;

  const messagesQuery = useQuery({
    queryKey: queryKeys.chat.messages(activeId ?? "none"),
    queryFn: () =>
      apiFetch<{ messages: ChatMessage[] }>(`/api/chat/conversations/${activeId}/messages`),
    enabled: !!activeId,
  });

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      let id = activeId;
      if (!id) {
        const created = await apiFetch<ConversationSummary>("/api/chat/conversations", {
          method: "POST",
        });
        id = created.id;
        setConversationId(id);
      }
      const turn = await apiFetch<TurnResponse>(`/api/chat/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      return { id, turn };
    },
    onSuccess: async ({ id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chat.messages(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chat.conversations() }),
      ]);
    },
    onError: (err, text) => {
      console.error("[CHAT] send failed:", err);
      captureClientError(err);
      // Never eat the user's words: put the failed message back in the box.
      setInput((prev) => (prev.trim() ? prev : text));
      setSendError(t("chat.sendFailed"));
    },
    onSettled: () => setPendingText(null),
  });

  const send = (raw: string) => {
    const text = raw.trim();
    if (!text || sendMutation.isPending) return;
    setSendError(null);
    setPendingText(text);
    setInput("");
    sendMutation.mutate(text);
  };

  const messages = messagesQuery.data?.messages ?? [];

  // Keep the newest message in view as the thread grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on thread growth
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pendingText]);

  return (
    <section className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-3xl flex-col px-4 pb-24 pt-4 md:pb-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">{t("nav.assistant")}</h1>
        <button
          type="button"
          onClick={() => setConversationId(null)}
          disabled={!activeId || sendMutation.isPending}
          className="focus-ring min-h-[44px] rounded-md border border-stone-600 px-3 text-sm text-stone-300 transition hover:border-stone-400 hover:text-white disabled:opacity-40"
        >
          {t("chat.newChat")}
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite">
        {activeId && messagesQuery.isLoading ? (
          <p className="text-sm text-stone-400">{t("chat.loadingConversation")}</p>
        ) : messages.length === 0 && !pendingText ? (
          <div className="mt-8 space-y-3">
            <p className="text-sm text-stone-300">{t("chat.emptyState")}</p>
            <ul className="space-y-2">
              {SUGGESTION_KEYS.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => send(t(key))}
                    className="focus-ring min-h-[44px] w-full rounded-lg border border-stone-700 px-3 py-2 text-left text-sm text-stone-300 transition hover:border-stone-500 hover:text-white"
                  >
                    {t(key)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {pendingText && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent/15 px-4 py-2 text-sm text-white">
                  <p className="whitespace-pre-wrap">{pendingText}</p>
                </div>
              </div>
            )}
            {sendMutation.isPending && (
              <p role="status" className="text-sm text-stone-400">
                {t("chat.thinking")}
              </p>
            )}
          </>
        )}
        {sendError && (
          <p role="alert" className="text-sm text-red-400">
            {sendError}
          </p>
        )}
        <div ref={threadEndRef} />
      </div>

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <div className="flex min-h-[44px] flex-1 items-center gap-2 rounded-xl border border-stone-600 bg-stone-900/70 px-3 py-2 focus-within:border-stone-400">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            maxLength={4000}
            placeholder={t("chat.inputPlaceholder")}
            aria-label="Message the assistant"
            className="max-h-32 flex-1 resize-none bg-transparent text-sm text-white outline-none placeholder:text-stone-500"
          />
          <VoiceButton
            onTranscript={(text) =>
              setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
            }
          />
        </div>
        <button
          type="submit"
          disabled={!input.trim() || sendMutation.isPending}
          className="focus-ring min-h-[44px] rounded-xl bg-accent px-4 text-sm font-semibold text-stone-950 transition hover:bg-accent/90 disabled:opacity-40"
        >
          {t("chat.send")}
        </button>
      </form>
    </section>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "USER") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent/15 px-4 py-2 text-sm text-white">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  const draft = message.metadata?.eventDraft;
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-stone-700/70 bg-stone-900/60 px-4 py-2 text-sm text-stone-100">
        <p className="whitespace-pre-wrap">{message.content}</p>
        {draft && <EventDraftCard draft={draft} />}
      </div>
    </div>
  );
}
