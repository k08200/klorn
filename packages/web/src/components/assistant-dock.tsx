"use client";

// Global assistant dock — the K chat lives bottom-right on EVERY app page
// instead of being exiled to its own nav destination. FAB toggles a floating
// panel; conversation state/cache is shared with /chat via useAssistantChat,
// so the thread follows the user across surfaces.

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ASSISTANT_ASK_EVENT, type AssistantAskDetail } from "../lib/assistant-ask";
import { useT } from "../lib/i18n";
import { type AssistantChatMessage, useAssistantChat } from "../lib/use-assistant-chat";
import EventDraftCard from "./event-draft-card";
import ErrorAlert from "./ui/error-alert";
import VoiceButton from "./voice-button";

const SUGGESTION_KEYS = [
  "chat.suggestion1",
  "chat.suggestion2",
  "chat.suggestion3",
  "chat.suggestion4",
];

export default function AssistantDock() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  // The dock floats over whatever page the user is on; on an email page that
  // means the mail they are reading. Sending its id is what makes "이 메일"
  // answerable without the model guessing through tools.
  const pathname = usePathname();
  const contextEmailId = pathname?.startsWith("/email/") ? (pathname.split("/")[2] ?? null) : null;
  const chat = useAssistantChat({ enabled: open, contextEmailId });
  const threadEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the thread grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on thread growth
  useEffect(() => {
    if (!open) return;
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.messages.length, chat.pendingText, open]);

  // Another surface (Today's ask box) hands over a question: open with it in
  // the composer. It is sent only when the user sends it here.
  const setInput = chat.setInput;
  useEffect(() => {
    const onAsk = (event: Event) => {
      const text = (event as CustomEvent<AssistantAskDetail>).detail?.text;
      if (typeof text !== "string" || !text.trim()) return;
      // Never drop a draft already in the composer: the question joins it.
      setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
      setOpen(true);
      // Already open: the focus-on-open effect will not run again.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener(ASSISTANT_ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASSISTANT_ASK_EVENT, onAsk);
  }, [setInput]);

  // Focus the composer when the panel opens; Escape closes it.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Panel */}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("nav.assistant")}
          className="panel-elevated ease-strong fixed bottom-24 right-4 z-[80] flex h-[min(600px,calc(100dvh-8rem))] w-[min(400px,calc(100vw-2rem))] origin-bottom-right flex-col overflow-hidden rounded-2xl border border-line/70 bg-surface-panel transition duration-200 starting:translate-y-2 starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-none md:bottom-[5.25rem] md:right-5"
        >
          {/* Head */}
          <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
            <span
              aria-hidden="true"
              className="avatar-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-[11px] font-semibold text-accent-solid-ink"
            >
              K
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-none text-ink">{t("nav.assistant")}</p>
              <p className="mt-1 truncate text-[11px] text-ink-dim">Mail · calendar · briefing</p>
            </div>
            <button
              type="button"
              onClick={chat.newChat}
              disabled={!chat.activeId || chat.sending}
              className="focus-ring ease-strong h-7 rounded-md px-2 text-[11px] font-medium text-ink-dim transition duration-150 hover:bg-surface-hover hover:text-ink active:scale-[0.97] disabled:opacity-40"
            >
              {t("chat.newChat")}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="focus-ring ease-strong flex h-7 w-7 items-center justify-center rounded-md text-ink-dim transition duration-150 hover:bg-surface-hover hover:text-ink active:scale-[0.97]"
            >
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Thread */}
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
            {chat.messagesLoading ? (
              <p className="text-sm text-ink-mid">{t("chat.loadingConversation")}</p>
            ) : chat.messages.length === 0 && !chat.pendingText ? (
              <div className="space-y-2.5 pt-1">
                <p className="text-sm text-ink-mid">{t("chat.emptyState")}</p>
                <ul className="space-y-1.5">
                  {SUGGESTION_KEYS.map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => chat.send(t(key))}
                        className="focus-ring ease-strong row-wash w-full rounded-lg border border-line bg-surface-panel/70 px-3 py-2 text-left text-[13px] text-ink-muted transition duration-150 hover:text-ink active:scale-[0.99]"
                      >
                        {t(key)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                {chat.messages.map((m) => (
                  <DockBubble key={m.id} message={m} />
                ))}
                {chat.pendingText && (
                  <div className="ease-strong flex justify-end transition duration-150 starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-3.5 py-2 text-[13px] text-slate-50 shadow-[0_1px_2px_rgba(15,23,42,0.16)]">
                      <p className="whitespace-pre-wrap">{chat.pendingText}</p>
                    </div>
                  </div>
                )}
                {chat.sending && (
                  <div role="status" className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="avatar-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-[10px] font-semibold text-accent-solid-ink"
                    >
                      K
                    </span>
                    <p className="text-[13px] text-ink-mid">{t("chat.thinking")}</p>
                  </div>
                )}
              </>
            )}
            {chat.sendError && <ErrorAlert>{t("chat.sendFailed")}</ErrorAlert>}
            <div ref={threadEndRef} />
          </div>

          {/* Composer */}
          <form
            className="border-t border-line-soft p-3"
            onSubmit={(e) => {
              e.preventDefault();
              chat.send(chat.input);
            }}
          >
            <div className="flex items-end gap-1.5 rounded-xl border border-line bg-surface-panel px-3 py-2 transition duration-150 ease-out focus-within:border-accent-muted/70 focus-within:ring-2 focus-within:ring-accent/15">
              <textarea
                ref={inputRef}
                value={chat.input}
                onChange={(e) => chat.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    chat.send(chat.input);
                  }
                }}
                rows={1}
                maxLength={4000}
                placeholder={t("chat.inputPlaceholder")}
                aria-label="Message the assistant"
                className="max-h-24 flex-1 resize-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-dim"
              />
              <VoiceButton
                onTranscript={(text) =>
                  chat.setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
                }
              />
              <button
                type="submit"
                disabled={!chat.input.trim() || chat.sending}
                aria-label={t("chat.send")}
                className="glow-primary ease-strong flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-solid text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m22 2-7 20-4-9-9-4Z" />
                  <path d="M22 2 11 13" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* FAB — sits above the mobile bottom tab bar, right-aligned on desktop. */}
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
        aria-label={open ? "Close assistant" : "Open assistant"}
        className="glow-primary ease-strong fixed bottom-24 right-4 z-[81] flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-accent-solid-ink transition duration-150 hover:opacity-90 active:scale-[0.94] md:bottom-5 md:right-5"
      >
        {open ? (
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ) : (
          <span className="text-[15px] font-bold">K</span>
        )}
      </button>
    </>
  );
}

function DockBubble({ message }: { message: AssistantChatMessage }) {
  if (message.role === "USER") {
    return (
      <div className="ease-strong flex justify-end transition duration-150 starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-3.5 py-2 text-[13px] text-slate-50 shadow-[0_1px_2px_rgba(15,23,42,0.16)]">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  const draft = message.metadata?.eventDraft;
  return (
    <div className="ease-strong flex justify-start gap-2 transition duration-150 starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
      <span
        aria-hidden="true"
        className="avatar-ring mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-solid to-accent-solid-hover text-[10px] font-semibold text-accent-solid-ink"
      >
        K
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-line/70 bg-surface-panel px-3.5 py-2 text-[13px] text-ink-strong shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
        <p className="whitespace-pre-wrap">{message.content}</p>
        {draft && <EventDraftCard draft={draft} />}
      </div>
    </div>
  );
}
