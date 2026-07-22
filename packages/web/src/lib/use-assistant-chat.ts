"use client";

// Shared assistant-chat engine used by BOTH the floating AssistantDock (every
// page, bottom-right) and the full /chat page. One hook, one React Query
// cache — opening the dock after using the page (or vice versa) resumes the
// same conversation with no refetch drift.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EventDraft } from "../components/event-draft-card";
import { apiFetch } from "./api";
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
  metadata: { eventDraft?: EventDraft; turnError?: string } | null;
  createdAt: string;
}

interface TurnResponse {
  reply: string;
  eventDraft: EventDraft | null;
  error?: string;
}

export function useAssistantChat(options?: { enabled?: boolean; onSendError?: () => void }) {
  const enabled = options?.enabled ?? true;
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Optimistic echo of the user's message while the turn is in flight.
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<boolean>(false);
  const [input, setInput] = useState("");

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

  return {
    activeId,
    input,
    setInput,
    send,
    newChat,
    pendingText,
    sendError,
    sending: sendMutation.isPending,
    messages: messagesQuery.data?.messages ?? [],
    messagesLoading: !!activeId && messagesQuery.isLoading,
  };
}
