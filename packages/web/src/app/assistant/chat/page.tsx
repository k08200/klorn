"use client";

import { ChatView } from "../../chat/chat-view";

/** /assistant/chat — the assistant thread, full page. The floating dock is the same thread. */
export default function AssistantChatPage() {
  return <ChatView hub />;
}
