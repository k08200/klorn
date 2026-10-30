/**
 * The assistant thread (Assistant artboard, "대화"): resumes the latest
 * conversation, sends one turn at a time, and renders the assistant's event
 * drafts as confirm cards. Shared by the Assistant tab and the expanded
 * layout's side sheet (same query cache, so both show the same thread).
 *
 * Chat only ever drafts (agentcore/chat-engine.ts): an event is written by the
 * card's Save alone, and mail is never sent from here.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useMe } from "../../api/queries";
import { hk, useChatMessages, useConversations } from "../../api/queries-hub";
import type { ChatMessageWire } from "../../api/wire";
import { getServices } from "../../app/services";
import { useI18n } from "../../i18n/I18nProvider";
import { useSpeechInput } from "../../platform/speech";
import { Icon } from "../../ui/Icon";
import { PlansLink } from "../../ui/PlansLink";
import { ProblemState, SkeletonRows } from "../../ui/StateView";
import { EventDraftCard } from "../calendar/EventDraftCard";
import { isKnownZone } from "../today/model";
import { onAssistantRequest, takeAssistantRequest } from "./handoff";
import { type ChatCapNotice, chatCapNotice, visibleMessages } from "./model";

const CHIPS = ["assistant.chip.urgent", "assistant.chip.receipts", "assistant.chip.week"] as const;

function SparkAvatar() {
  return (
    <span className="chat-avatar" aria-hidden="true">
      <Icon name="sparkSmall" size={15} strokeWidth={2} />
    </span>
  );
}

function Message({
  message,
  zone,
  cap,
}: {
  message: ChatMessageWire;
  zone: string;
  /** This reply is the server's allowance-reached text: say it in the app's language. */
  cap?: ChatCapNotice;
}) {
  const { t } = useI18n();
  if (message.role === "USER") {
    return <p className="chat-bubble selectable">{message.content}</p>;
  }
  const draft = message.metadata?.eventDraft;
  return (
    <div className="chat-reply">
      <SparkAvatar />
      <div className="chat-reply__body">
        {cap ? (
          <p className="chat-reply__text selectable">
            {t(cap.key)}
            {cap.plans ? (
              <>
                {" "}
                <PlansLink />
              </>
            ) : null}
          </p>
        ) : (
          <p className="chat-reply__text selectable">{message.content}</p>
        )}
        {draft ? <EventDraftCard draft={draft} zone={zone} /> : null}
        {message.metadata?.turnError && !cap ? (
          <p className="chat-reply__error">{t("assistant.chat.turnError")}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ChatThread({
  variant = "page",
  newChat = false,
}: {
  variant?: "page" | "sheet";
  /** Start a new conversation instead of resuming the latest one. */
  newChat?: boolean;
}) {
  const { t, intlTag } = useI18n();
  const queryClient = useQueryClient();
  const me = useMe();
  const tz = me.data?.timezone;
  const zone = isKnownZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const conversations = useConversations();
  // undefined = resume the latest conversation; null = a new one (created on first send).
  const [chosen, setChosen] = useState<string | null | undefined>(newChat ? null : undefined);
  const activeId = chosen === undefined ? (conversations.data?.[0]?.id ?? null) : chosen;
  const messages = useChatMessages(activeId);
  const [input, setInput] = useState("");
  const [contextEmailId, setContextEmailId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Replies that stopped at the daily allowance, by the server's reply text
  // (the stored message carries the same text, so the refetched thread matches).
  const [capped, setCapped] = useState<ReadonlyMap<string, ChatCapNotice>>(new Map());
  const scroll = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const voice = useSpeechInput(intlTag, (text) =>
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
  );

  // Another screen asked the assistant something: put it in the composer.
  useEffect(() => {
    const take = () => {
      const request = takeAssistantRequest();
      if (!request) return;
      setInput(request.text);
      setContextEmailId(request.emailId ?? null);
      requestAnimationFrame(() => field.current?.focus());
    };
    take();
    return onAssistantRequest(take);
  }, []);

  const shown = visibleMessages(messages.data ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content only
  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, pending]);

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || pending) return;
    setFailed(false);
    setPending(text);
    setInput("");
    try {
      const { ep } = getServices();
      let id = activeId;
      if (!id) {
        const created = await ep.assistant.createConversation();
        id = created.id;
        setChosen(id);
      }
      const turn = await ep.assistant.send(id, text, contextEmailId);
      const notice = chatCapNotice(turn.errorCode);
      if (notice) setCapped((prev) => new Map(prev).set(turn.reply, notice));
      setContextEmailId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: hk.messages(id) }),
        queryClient.invalidateQueries({ queryKey: hk.conversations }),
      ]);
    } catch {
      // Never eat the user's words: back into the box.
      setInput((prev) => (prev.trim() ? prev : text));
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const loading =
    conversations.isPending || (activeId !== null && messages.isPending && !messages.data);
  const loadFailed = conversations.isError && !conversations.data;

  return (
    <div className={`chat chat--${variant}`}>
      <div
        ref={scroll}
        className="chat__scroll"
        aria-live="polite"
        aria-busy={loading || undefined}
      >
        {variant === "page" ? null : (
          <button type="button" className="chat__new" onClick={() => setChosen(null)}>
            <Icon name="plus" size={16} strokeWidth={2} />
            {t("assistant.chat.new")}
          </button>
        )}
        {loadFailed ? (
          <ProblemState kind="error" onRetry={() => void conversations.refetch()} compact />
        ) : loading ? (
          <SkeletonRows rows={2} />
        ) : shown.length === 0 && !pending ? (
          <div className="chat-reply chat-reply--welcome">
            <SparkAvatar />
            <div className="chat-reply__body">
              <p className="chat-reply__text">{t("assistant.chat.welcome")}</p>
              <p className="chat-reply__hint">{t("assistant.chat.scope")}</p>
            </div>
          </div>
        ) : (
          shown.map((m) => (
            <Message
              key={m.id}
              message={m}
              zone={zone}
              cap={m.role === "ASSISTANT" ? capped.get(m.content) : undefined}
            />
          ))
        )}
        {pending ? (
          <>
            <p className="chat-bubble chat-bubble--pending">{pending}</p>
            <div className="chat-reply" role="status">
              <SparkAvatar />
              <span className="chat-typing">
                <span />
                <span />
                <span />
                <span className="sr-only">{t("assistant.chat.thinking")}</span>
              </span>
            </div>
          </>
        ) : null}
        {failed ? (
          <p className="form-error" role="alert">
            {t("assistant.chat.sendFailed")}
          </p>
        ) : null}
      </div>
      <form className="chat-composer" aria-label={t("assistant.chat.composer")} onSubmit={onSubmit}>
        <div className="chat-composer__chips">
          {CHIPS.map((key) => (
            <button
              key={key}
              type="button"
              className="chat-composer__chip"
              disabled={!!pending}
              onClick={() => void send(t(key))}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <div className="chat-composer__row">
          <label className="chat-composer__field">
            <span className="sr-only">{t("assistant.chat.message")}</span>
            <textarea
              ref={field}
              rows={1}
              value={input}
              maxLength={4000}
              placeholder={t("assistant.chat.placeholder")}
              enterKeyHint="send"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            {voice.supported ? (
              <button
                type="button"
                className="chat-composer__mic"
                aria-pressed={voice.listening}
                onClick={voice.toggle}
              >
                <Icon
                  name={voice.listening ? "stop" : "mic"}
                  size={20}
                  label={t(voice.listening ? "assistant.chat.voiceStop" : "assistant.chat.voice")}
                />
              </button>
            ) : null}
          </label>
          <button
            type="submit"
            className="chat-composer__send"
            disabled={!input.trim() || !!pending}
          >
            <Icon name="arrowUp" size={20} strokeWidth={2.2} label={t("assistant.chat.send")} />
          </button>
        </div>
        {contextEmailId ? (
          <span className="chat-composer__context">{t("assistant.chat.aboutMail")}</span>
        ) : null}
      </form>
    </div>
  );
}
