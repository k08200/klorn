"use client";

// Shared assistant-chat engine used by BOTH the floating AssistantDock (every
// page, bottom-right) and the full /chat page. One hook, one React Query
// cache — opening the dock after using the page (or vice versa) resumes the
// same conversation with no refetch drift.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EventDraft } from "../components/event-draft-card";
import { apiFetch } from "./api";
import { type CapTurn, capCodeForMessage, capTurnFrom, type DailyCapCode } from "./daily-cap";
import { queryKeys } from "./query-keys";
import { captureClientError } from "./sentry";

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface AssistantChatMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  metadata: { eventDraft?: EventDraft; turnError?: string; errorCode?: string } | null;
  createdAt: string;
}

interface TurnResponse {
  reply: string;
  eventDraft: EventDraft | null;
  error?: string;
  /** DAILY_COST_CAP_FREE | DAILY_COST_CAP when the daily AI allowance is spent; absent on an older API. */
  errorCode?: string;
}

export function useAssistantChat(options?: {
  enabled?: boolean;
  onSendError?: () => void;
  /** Id of the mail the user is currently reading, so "this email" resolves. */
  contextEmailId?: string | null;
}) {
  const enabled = options?.enabled ?? true;
  const contextEmailId = options?.contextEmailId ?? null;
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Optimistic echo of the user's message while the turn is in flight.
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<boolean>(false);
  const [input, setInput] = useState("");
  // The last turn, when it hit the daily AI allowance (lib/daily-cap.ts).
  const [capTurn, setCapTurn] = useState<CapTurn | null>(null);

  const conversationsQuery = useQuery({
    queryKey: queryKeys.chat.conversations(),
    queryFn: () => apiFetch<{ conversations: ConversationSummary[] }>("/api/chat/conversations"),
    enabled,
  });

  // Latest conversation resumes by default; "New chat" resets to null.
  const activeId = conversationId ?? conversationsQuery.data?.conversations[0]?.id ?? null;

  const messagesQuery = useQuery({
    queryKey: queryKeys.chat.messages(activeId ?? "none"),
    queryFn: () =>
      apiFetch<{ messages: AssistantChatMessage[] }>(
        `/api/chat/conversations/${activeId}/messages`,
      ),
    enabled: enabled && !!activeId,
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
        body: JSON.stringify({
          text,
          ...(contextEmailId ? { context: { emailId: contextEmailId } } : {}),
        }),
      });
      return { id, turn };
    },
    onSuccess: async ({ id, turn }) => {
      setCapTurn(capTurnFrom(turn));
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
      setSendError(true);
      options?.onSendError?.();
    },
    onSettled: () => setPendingText(null),
  });

  const send = (raw: string) => {
    const text = raw.trim();
    if (!text || sendMutation.isPending) return;
    setSendError(false);
    setPendingText(text);
    setInput("");
    sendMutation.mutate(text);
  };

  const newChat = () => setConversationId(null);

  /** The cap code an assistant bubble stands for; null renders it as written. */
  const capCodeFor = (message: AssistantChatMessage): DailyCapCode | null =>
    capCodeForMessage(message, capTurn);

  return {
    activeId,
    input,
    setInput,
    send,
    newChat,
    pendingText,
    sendError,
    capCodeFor,
    sending: sendMutation.isPending,
    messages: messagesQuery.data?.messages ?? [],
    messagesLoading: !!activeId && messagesQuery.isLoading,
  };
}
