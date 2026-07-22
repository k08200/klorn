"use client";

// Assistant chat — the user-facing conversational surface, scoped to Klorn
// data (mail / calendar / briefing) by the server-side chat engine. Calendar
// drafts render as confirm cards (EventDraftCard); the save stays on the
// Pro-gated POST /api/calendar.

import { useEffect, useRef } from "react";
import AuthGuard from "../../components/auth-guard";
import EventDraftCard from "../../components/event-draft-card";
import VoiceButton from "../../components/voice-button";
import { useT } from "../../lib/i18n";
import {
  type AssistantChatMessage as ChatMessage,
  useAssistantChat,
} from "../../lib/use-assistant-chat";

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
  const {
    activeId,
    input,
    setInput,
    send,
    newChat,
    pendingText,
    sendError,
    sending,
    messages,
    messagesLoading,
  } = useAssistantChat();
  const threadEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest message in view as the thread grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on thread growth
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pendingText]);

  return (
    <section className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-3xl flex-col px-4 pb-24 pt-4 md:pb-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-slate-900">
            {t("nav.assistant")}
          </h1>
          <p className="mt-2 text-sm text-slate-500">Ask about your mail, calendar, and briefing</p>
        </div>
        <button
          type="button"
          onClick={newChat}
          disabled={!activeId || sending}
          className="focus-ring ease-strong inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-sm font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97] disabled:opacity-40 md:min-h-9"
        >
          {t("chat.newChat")}
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite">
        {messagesLoading ? (
          <p className="text-sm text-slate-500">{t("chat.loadingConversation")}</p>
        ) : messages.length === 0 && !pendingText ? (
          <div className="mt-8 space-y-3">
            <p className="text-sm text-slate-500">{t("chat.emptyState")}</p>
            <ul className="space-y-2">
              {SUGGESTION_KEYS.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => send(t(key))}
                    className="focus-ring ease-strong row-wash min-h-[44px] w-full rounded-xl border border-slate-200 bg-white/70 px-4 py-2.5 text-left text-sm text-slate-600 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:text-slate-900 active:scale-[0.99]"
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
              <div className="flex justify-end transition duration-150 ease-strong starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-4 py-2.5 text-sm text-slate-50 shadow-[0_1px_2px_rgba(15,23,42,0.16)]">
                  <p className="whitespace-pre-wrap">{pendingText}</p>
                </div>
              </div>
            )}
            {sending && (
              <div role="status" className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="avatar-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-sky-600 text-[11px] font-semibold text-white"
                >
                  K
                </span>
                <p className="text-sm text-slate-500">{t("chat.thinking")}</p>
              </div>
            )}
          </>
        )}
        {sendError && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {t("chat.sendFailed")}
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
        <div className="panel-elevated flex min-h-[44px] flex-1 items-center gap-2 rounded-2xl border border-slate-200/70 bg-white px-3.5 py-2 transition duration-150 ease-out focus-within:border-sky-300/70 focus-within:ring-2 focus-within:ring-accent/15">
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
            className="max-h-32 flex-1 resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
          <VoiceButton
            onTranscript={(text) =>
              setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
            }
          />
        </div>
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className="focus-ring glow-primary ease-strong inline-flex min-h-[44px] items-center rounded-xl bg-gradient-to-b from-sky-400 to-sky-500 px-4 text-sm font-semibold text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
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
      <div className="flex justify-end transition duration-150 ease-strong starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-4 py-2.5 text-sm text-slate-50 shadow-[0_1px_2px_rgba(15,23,42,0.16)]">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  const draft = message.metadata?.eventDraft;
  return (
    <div className="flex justify-start gap-2.5 transition duration-150 ease-strong starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
      <span
        aria-hidden="true"
        className="avatar-ring mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-sky-600 text-[11px] font-semibold text-white"
      >
        K
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-slate-200/70 bg-white px-4 py-2.5 text-sm text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
        <p className="whitespace-pre-wrap">{message.content}</p>
        {draft && <EventDraftCard draft={draft} />}
      </div>
    </div>
  );
}
