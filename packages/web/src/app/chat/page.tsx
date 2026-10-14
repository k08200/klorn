"use client";

import AuthGuard from "../../components/auth-guard";
import { ChatView } from "./chat-view";

export default function ChatPage() {
  return (
    <AuthGuard>
      <ChatView />
    </AuthGuard>
  );
}
