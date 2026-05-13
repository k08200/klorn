"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { Markdown } from "../../../components/markdown";
import SpeakButton from "../../../components/speak-button";
import { useToast } from "../../../components/toast";
import VoiceButton from "../../../components/voice-button";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  metadata?: string | null;
  createdAt: string;
}

interface PendingAction {
  id: string;
  messageId: string;
  status: "PENDING" | "REJECTED" | "EXECUTED" | "FAILED";
  toolName: string;
  toolArgs: string;
  /** Server-resolved human label (task title, contact name, …) — null when n/a */
  targetLabel?: string | null;
  reasoning?: string;
  result?: string;
}

function ThreadMetric({
  label,
  value,
  tone = "idle",
}: {
  label: string;
  value: number;
  tone?: "idle" | "hot";
}) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-1.5 ${
        tone === "hot"
          ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
          : "border-stone-700/45 bg-stone-950/35 text-stone-300"
      }`}
    >
      <p className="text-[10px] text-stone-600">{label}</p>
      <p className="text-sm font-semibold leading-none">{value}</p>
    </div>
  );
}

export default function ChatPage() {
  return (
    <AuthGuard>
      <Suspense>
        <ChatPageContent />
      </Suspense>
    </AuthGuard>
  );
}

function ChatPageContent() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachment, setAttachment] = useState<{ name: string; content: string } | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [pendingActions, setPendingActions] = useState<Map<string, PendingAction>>(new Map());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skillsList, setSkillsList] = useState<
    Array<{ id: string; name: string; description: string; prompt: string }>
  >([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const prefillHandled = useRef(false);
  const { toast } = useToast();

  const loadPendingActions = useCallback(
    async (signal?: AbortSignal) => {
      const data = await apiFetch<{ actions: PendingAction[] }>(
        `/api/chat/conversations/${id}/pending-actions`,
      );
      if (signal?.aborted) return;
      const map = new Map<string, PendingAction>();
      for (const action of data.actions) map.set(action.messageId, action);
      setPendingActions(map);
    },
    [id],
  );

  const reloadThreadState = useCallback(async () => {
    const data = await apiFetch<{ messages: Message[] }>(`/api/chat/conversations/${id}`);
    setMessages(data.messages);
    await loadPendingActions();
  }, [id, loadPendingActions]);

  // Load conversation + pending actions
  useEffect(() => {
    const loadController = new AbortController();

    apiFetch<{ messages: Message[]; title?: string | null }>(`/api/chat/conversations/${id}`)
      .then((data) => {
        if (loadController.signal.aborted) return;
        setLoadError(null);
        setMessages(data.messages);

        const prefill = searchParams.get("prefill");
        if (prefill && !prefillHandled.current && data.messages.length === 0) {
          prefillHandled.current = true;
          const userMsg: Message = {
            id: crypto.randomUUID(),
            role: "USER",
            content: prefill,
            createdAt: new Date().toISOString(),
          };
          setMessages([userMsg]);
          streamResponseDirect(prefill);
        }
      })
      .catch((err) => {
        if (loadController.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "스레드를 불러오지 못했어요.";
        if (msg.includes("403") || msg.includes("Forbidden")) {
          setLoadError("이 스레드에 접근할 수 없어요. 다른 계정으로 다시 시도해주세요.");
        } else if (msg.includes("404") || msg.includes("not found")) {
          setLoadError("스레드를 찾을 수 없어요.");
        } else {
          setLoadError(msg);
        }
      });

    // Fetch pending actions for this conversation
    loadPendingActions(loadController.signal).catch((err) =>
      captureClientError(err, { scope: "chat.load-pending-actions", id }),
    );

    return () => {
      loadController.abort();
    };
  }, [id, searchParams, loadPendingActions]);

  // Intentionally do NOT abort in-flight streams on unmount or conversation
  // change. The server keeps generating and writes the final response to the
  // DB even if the client disconnects, so navigating to /briefing (or opening
  // another conversation) should NOT cancel the answer the user is waiting
  // for. The only way to stop a stream is the explicit Stop button, which
  // calls abortRef.current?.abort() directly.

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const handler = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 200);
    };
    el.addEventListener("scroll", handler);
    return () => el.removeEventListener("scroll", handler);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;

    if (val === "/") {
      apiFetch<{ skills: typeof skillsList }>("/api/skills")
        .then((data) => {
          setSkillsList(data.skills || []);
          setShowSkillPicker(true);
        })
        .catch(() => setShowSkillPicker(false));
    } else if (!val.startsWith("/") || val.includes(" ")) {
      setShowSkillPicker(false);
    }
  };

  const selectSkill = (skill: { name: string; prompt: string }) => {
    setInput(`Run skill "${skill.name}"`);
    setShowSkillPicker(false);
    inputRef.current?.focus();
  };

  const generateSuggestions = (userMsg: string, assistantMsg: string) => {
    const s: string[] = [];
    const lower = `${userMsg} ${assistantMsg}`.toLowerCase();

    if (lower.includes("email") || lower.includes("mail")) {
      s.push("Show only important mail", "Draft a reply");
    } else if (lower.includes("task") || lower.includes("todo")) {
      s.push("Show today's deadlines", "Sort by priority");
    } else if (lower.includes("calendar") || lower.includes("schedule")) {
      s.push("Show this week's schedule", "Find open time");
    } else if (lower.includes("note") || lower.includes("memo")) {
      s.push("Show recent notes", "Draft a report");
    }

    if (s.length === 0) {
      s.push("Show more evidence", "Compare other options");
    }
    s.push("Summarize this");
    setSuggestions(s.slice(0, 3));
  };

  const processStream = async (res: Response, messageContent: string) => {
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";

    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "token") {
                fullContent += data.content;
                setStreamingContent(fullContent);
              } else if (data.type === "tool_call") {
                setActiveTools((prev) => [...prev, data.name]);
              } else if (data.type === "tool_result") {
                setActiveTools((prev) => prev.filter((t) => t !== data.name));
              } else if (data.type === "error") {
                fullContent += `\n\n[Error: ${data.content}]`;
                setStreamingContent(fullContent);
              }
            } catch {
              // skip
            }
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          if (fullContent) {
            const partialMsg: Message = {
              id: crypto.randomUUID(),
              role: "ASSISTANT",
              content: `${fullContent}\n\n_[Generation stopped]_`,
              createdAt: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, partialMsg]);
            setStreaming(false);
            setStreamingContent("");
            setActiveTools([]);
            return;
          }
        }
        throw err;
      }
    }

    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "ASSISTANT",
      content: fullContent,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, assistantMsg]);
    generateSuggestions(messageContent, fullContent);
  };

  const streamResponseDirect = async (messageContent: string) => {
    setStreaming(true);
    setStreamingContent("");
    setSuggestions([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${id}/messages`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: messageContent }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await processStream(res, messageContent);
      await reloadThreadState();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled — don't retry
      } else {
        // Auto-retry with exponential backoff (max 2 retries)
        const retryCount = (streamResponseDirect as unknown as { _retries?: number })._retries || 0;
        if (retryCount < 2) {
          const delay = Math.min(1000 * 2 ** retryCount, 8000);
          (streamResponseDirect as unknown as { _retries: number })._retries = retryCount + 1;
          setStreamingContent("Connection dropped. Reconnecting...");
          await new Promise((r) => setTimeout(r, delay));
          if (!abortRef.current?.signal.aborted) {
            await streamResponseDirect(messageContent);
            return;
          }
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "ASSISTANT",
              content: "Reconnect failed. Please try again.",
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      }
    }

    (streamResponseDirect as unknown as { _retries: number })._retries = 0;
    abortRef.current = null;
    setStreaming(false);
    setStreamingContent("");
    setActiveTools([]);
    // Notify sidebar to refresh conversation list (title may have been auto-generated)
    window.dispatchEvent(new Event("conversations-updated"));
  };

  const streamResponse = async (messageContent: string) => {
    setStreaming(true);
    setStreamingContent("");
    setSuggestions([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${id}/messages`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: messageContent }),
        signal: controller.signal,
      });

      if (res.status === 402) {
        const err = await res.json();
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "ASSISTANT",
            content: `이번 달 결정 턴 한도(${err.messageLimit}회)에 도달했어요. 현재 플랜: **${err.plan}**. [플랜 변경](/billing)`,
            createdAt: new Date().toISOString(),
          },
        ]);
        setStreaming(false);
        return;
      }

      await processStream(res, messageContent);
      await reloadThreadState();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "ASSISTANT",
            content: "Connection failed. Please try again.",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    }

    abortRef.current = null;
    setStreaming(false);
    setStreamingContent("");
    setActiveTools([]);
    inputRef.current?.focus();
  };

  const retryMessage = async (msgIndex: number) => {
    if (streaming) return;
    const assistantMsg = messages[msgIndex];
    if (!assistantMsg || assistantMsg.role !== "ASSISTANT") return;

    setMessages((prev) => prev.filter((m) => m.id !== assistantMsg.id));
    setStreaming(true);
    setStreamingContent("");

    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${id}/retry`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await processStream(res, "");
      await reloadThreadState();
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "ASSISTANT",
          content: "Could not regenerate the response. Please try again.",
          createdAt: new Date().toISOString(),
        },
      ]);
    }

    setStreaming(false);
    setStreamingContent("");
    setActiveTools([]);
  };

  const startEditMessage = (msg: Message) => {
    setEditingMsgId(msg.id);
    setEditContent(msg.content);
  };

  const submitEditMessage = async (msgIndex: number) => {
    if (streaming || !editContent.trim()) return;
    const edited = editContent.trim();
    setEditingMsgId(null);
    setEditContent("");

    // Remove this message and all messages after it, then resend
    setMessages((prev) => {
      const updated = prev.slice(0, msgIndex);
      updated.push({
        id: crypto.randomUUID(),
        role: "USER",
        content: edited,
        createdAt: new Date().toISOString(),
      });
      return updated;
    });

    await streamResponse(edited);
  };

  const sendMessage = async () => {
    let content = input.trim();
    if (!content && !attachment) return;
    if (streaming) return;

    if (attachment) {
      const prefix = `[Attached file: ${attachment.name}]\n\`\`\`\n${attachment.content.slice(0, 8000)}\n\`\`\`\n\n`;
      content = prefix + content;
      setAttachment(null);
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "USER",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    await streamResponse(content);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 512_000) {
      toast("File is too large. Maximum size is 500 KB.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAttachment({ name: file.name, content: reader.result as string });
    };
    if (
      file.type.startsWith("text/") ||
      file.name.match(/\.(json|csv|md|txt|yaml|yml|xml|log)$/i)
    ) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && showSkillPicker) {
      setShowSkillPicker(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const copyMessage = (content: string) => {
    navigator.clipboard.writeText(content);
    toast("복사했어요.", "success");
  };

  const exportConversation = () => {
    if (messages.length === 0) return;
    const lines = messages.map((m) => {
      const label = m.role === "USER" ? "**나**" : "**Jigeum**";
      const time = new Date(m.createdAt).toLocaleString("ko-KR");
      return `### ${label} — ${time}\n\n${m.content}`;
    });
    const md = `# Jigeum 결정 스레드\n\n내보낸 시각: ${new Date().toLocaleString("ko-KR")}\n\n---\n\n${lines.join("\n\n---\n\n")}`;
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jigeum-chat-${id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Markdown으로 내보냈어요.", "success");
  };

  const handleActionApprove = async (actionId: string, autoAllow = false) => {
    setActionLoading(actionId);
    try {
      await apiFetch(`/api/chat/pending-actions/${actionId}/approve`, {
        method: "POST",
        body: JSON.stringify({ autoAllow }),
      });
      setPendingActions((prev) => {
        const next = new Map(prev);
        const action = [...prev.values()].find((a) => a.id === actionId);
        if (action) next.set(action.messageId, { ...action, status: "EXECUTED" });
        return next;
      });
      toast("실행했어요.", "success");
      // Reload messages to get the follow-up message
      apiFetch<{ messages: Message[] }>(`/api/chat/conversations/${id}`)
        .then((data) => setMessages(data.messages))
        .catch((err) => captureClientError(err, { scope: "chat.reload-after-action", id }));
    } catch {
      toast("실행하지 못했어요.", "error");
    }
    setActionLoading(null);
  };

  const handleActionReject = async (actionId: string, neverSuggest = false) => {
    const reason = neverSuggest
      ? "다시 제안하지 않기"
      : window.prompt("거절 이유가 있으면 적어주세요.");
    if (reason === null) return;
    setActionLoading(actionId);
    try {
      await apiFetch(`/api/chat/pending-actions/${actionId}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason?.trim() || undefined, neverSuggest }),
      });
      setPendingActions((prev) => {
        const next = new Map(prev);
        const action = [...prev.values()].find((a) => a.id === actionId);
        if (action) next.set(action.messageId, { ...action, status: "REJECTED" });
        return next;
      });
      // Reload messages to get the follow-up message
      apiFetch<{ messages: Message[] }>(`/api/chat/conversations/${id}`)
        .then((data) => setMessages(data.messages))
        .catch((err) => captureClientError(err, { scope: "chat.reload-after-action", id }));
    } catch {
      toast("액션을 처리하지 못했어요.", "error");
    }
    setActionLoading(null);
  };

  const approvalCount = [...pendingActions.values()].filter(
    (action) => action.status === "PENDING",
  ).length;
  const assistantCount = messages.filter((message) => message.role === "ASSISTANT").length;
  const userCount = messages.filter((message) => message.role === "USER").length;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      {messages.length > 0 && (
        <div className="border-b border-stone-700/35 bg-[#11100d]/82 px-4 py-3 backdrop-blur-xl">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300/75">
                결정 스레드
              </p>
              <p className="text-xs text-stone-500">
                맥락을 먼저 보고, 실행은 승인 뒤에 진행합니다.
              </p>
            </div>
            <div className="hidden items-center gap-2 md:flex">
              <ThreadMetric label="요청" value={userCount} />
              <ThreadMetric label="답변" value={assistantCount} />
              <ThreadMetric
                label="승인"
                value={approvalCount}
                tone={approvalCount > 0 ? "hot" : "idle"}
              />
            </div>
            <button
              type="button"
              onClick={exportConversation}
              className="flex items-center gap-1.5 rounded-lg border border-stone-700/40 px-2.5 py-1.5 text-xs text-stone-500 transition hover:border-stone-600 hover:bg-stone-900/60 hover:text-stone-300"
              title="Markdown으로 내보내기"
            >
              <svg
                aria-hidden="true"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              내보내기
            </button>
          </div>
        </div>
      )}
      {/* Messages */}
      <div ref={scrollAreaRef} className="relative flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
          {loadError && (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center text-xl mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-red-400"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <p className="text-stone-300 text-sm mb-4">{loadError}</p>
              <a href="/chat" className="text-sm text-amber-300 hover:text-amber-200 transition">
                스레드로 돌아가기
              </a>
            </div>
          )}
          {!loadError && messages.length === 0 && !streaming && (
            <div className="flex min-h-[60vh] flex-col items-center justify-center">
              <img src="/brand/mark.svg?v=flow-5" alt="" className="mb-4 h-12 w-12" />
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-300/75">
                새 결정 스레드
              </p>
              <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight text-stone-100">
                필요한 결과부터 시작하세요.
              </h2>
              <p className="mb-8 max-w-md text-center text-sm leading-6 text-stone-500">
                Jigeum은 지금의 업무 맥락을 읽고, 왜 중요한지 설명한 뒤 승인 가능한 다음 행동으로
                정리합니다.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
                {[
                  {
                    code: "01",
                    title: "오늘 결정할 일 정리",
                    prompt: "오늘 내가 처리해야 할 결정을 우선순위로 정리해줘.",
                  },
                  {
                    code: "02",
                    title: "숨은 리스크 추적",
                    prompt: "메일, 캘린더, 작업에서 위험 신호를 찾아줘.",
                  },
                  {
                    code: "03",
                    title: "오늘 일정 준비",
                    prompt: "오늘 미팅을 훑고 필요한 맥락과 질문을 준비해줘.",
                  },
                  {
                    code: "04",
                    title: "다음 액션 초안",
                    prompt: "후속 조치가 필요한 스레드를 찾고 다음 액션을 써줘.",
                  },
                ].map((starter) => (
                  <button
                    key={starter.title}
                    type="button"
                    onClick={() => {
                      const userMsg: Message = {
                        id: crypto.randomUUID(),
                        role: "USER",
                        content: starter.prompt,
                        createdAt: new Date().toISOString(),
                      };
                      setMessages([userMsg]);
                      streamResponse(starter.prompt);
                    }}
                    className="group flex items-start gap-3 rounded-xl border border-stone-700/50 bg-stone-950/35 px-4 py-3.5 text-left transition hover:border-amber-500/35 hover:bg-amber-500/10"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-stone-700/70 text-[10px] font-semibold text-amber-200">
                      {starter.code}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-stone-300 transition group-hover:text-white">
                        {starter.title}
                      </p>
                      <p className="mt-0.5 line-clamp-1 text-xs text-stone-600">{starter.prompt}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div
              key={msg.id}
              className={`group py-5 ${idx > 0 ? "border-t border-stone-800/30" : ""}`}
            >
              <div className="flex gap-4">
                {/* Avatar */}
                <div className="shrink-0 pt-0.5">
                  {msg.role === "USER" ? (
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-stone-700 bg-stone-900 text-[10px] font-bold text-white">
                      U
                    </div>
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-300/25 bg-amber-300/10">
                      <img src="/brand/mark.svg?v=flow-5" alt="" className="h-5 w-5" />
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <p className="mb-1.5 text-[13px] font-semibold text-stone-300">
                    {msg.role === "USER" ? "나" : "Jigeum"}
                  </p>
                  {msg.role === "USER" && editingMsgId === msg.id ? (
                    <div>
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            submitEditMessage(idx);
                          }
                          if (e.key === "Escape") {
                            setEditingMsgId(null);
                            setEditContent("");
                          }
                        }}
                        className="w-full bg-stone-800 border border-stone-600 rounded-lg px-3 py-2 text-[15px] text-stone-200 resize-none focus:outline-none focus:border-amber-500/50"
                        rows={Math.min(editContent.split("\n").length + 1, 8)}
                      />
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => submitEditMessage(idx)}
                          className="px-3 py-1 text-xs bg-amber-300 text-stone-950 rounded-lg hover:bg-amber-200 transition"
                        >
                          저장 후 다시 보내기
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMsgId(null);
                            setEditContent("");
                          }}
                          className="px-3 py-1 text-xs text-stone-400 hover:text-stone-200 transition"
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  ) : msg.role === "USER" ? (
                    <p className="whitespace-pre-wrap rounded-2xl border border-stone-700/40 bg-stone-950/45 px-4 py-3 text-[15px] leading-relaxed text-stone-200">
                      {msg.content}
                    </p>
                  ) : (
                    <div className="rounded-2xl border border-stone-700/35 bg-stone-950/35 px-4 py-3 text-[15px] leading-relaxed text-stone-200">
                      <Markdown content={msg.content} />
                      <div className="mt-2">
                        <SpeakButton text={msg.content} />
                      </div>
                    </div>
                  )}

                  {/* Pending Action Buttons */}
                  {msg.role === "ASSISTANT" &&
                    pendingActions.has(msg.id) &&
                    (() => {
                      const action = pendingActions.get(msg.id);
                      if (!action) return null;
                      const isLoading = actionLoading === action.id;

                      if (action.status === "PENDING") {
                        const args = (() => {
                          try {
                            return JSON.parse(action.toolArgs);
                          } catch {
                            return {};
                          }
                        })();
                        const preview = (() => {
                          const name = action.toolName;
                          if (name === "send_email")
                            return `받는 사람: ${args.to || "?"} · ${args.subject || "제목 없음"}`;
                          if (name === "create_event")
                            return `${args.title || "일정"} · ${args.startTime ? new Date(args.startTime).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}${args.location ? ` · ${args.location}` : ""}`;
                          if (name === "create_task") return args.title || "새 작업";
                          if (name === "create_note") return args.title || "새 메모";
                          if (name === "create_contact")
                            return `${args.name || "?"} ${args.email ? `(${args.email})` : ""}`;
                          if (
                            name === "delete_task" ||
                            name === "delete_note" ||
                            name === "delete_contact"
                          ) {
                            const idKey =
                              name === "delete_task"
                                ? "task_id"
                                : name === "delete_note"
                                  ? "note_id"
                                  : "contact_id";
                            const label =
                              action.targetLabel || args[idKey] || args.id || "항목을 찾을 수 없음";
                            return `삭제: ${label}`;
                          }
                          if (
                            name === "update_task" ||
                            name === "update_note" ||
                            name === "update_contact"
                          ) {
                            const idKey =
                              name === "update_task"
                                ? "task_id"
                                : name === "update_note"
                                  ? "note_id"
                                  : "contact_id";
                            const label =
                              action.targetLabel || args[idKey] || args.id || "항목을 찾을 수 없음";
                            return `수정: ${label}`;
                          }
                          return null;
                        })();
                        return (
                          <div className="mt-3 space-y-2">
                            {preview && (
                              <div className="text-xs text-stone-400 bg-stone-800/50 rounded-lg px-3 py-2 border border-stone-700/50">
                                {preview}
                              </div>
                            )}
                            <div className="rounded-xl border border-amber-300/15 bg-amber-300/5 p-3">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleActionApprove(action.id)}
                                  disabled={isLoading}
                                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold rounded-lg bg-amber-300 hover:bg-amber-200 text-stone-950 disabled:opacity-50 disabled:cursor-not-allowed transition"
                                >
                                  {isLoading ? (
                                    <span className="w-3 h-3 border-2 border-stone-950/30 border-t-stone-950 rounded-full animate-spin" />
                                  ) : (
                                    <svg
                                      aria-hidden="true"
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  )}
                                  승인
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleActionReject(action.id)}
                                  disabled={isLoading}
                                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg border border-stone-600 text-stone-300 hover:bg-stone-800 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition"
                                >
                                  거절
                                </button>
                              </div>
                              <div className="mt-2 flex items-center gap-3 text-[11px]">
                                <button
                                  type="button"
                                  onClick={() => handleActionApprove(action.id, true)}
                                  disabled={isLoading}
                                  className="text-amber-300 hover:text-amber-200 disabled:opacity-50 transition"
                                >
                                  이 도구는 항상 허용
                                </button>
                                <span className="text-stone-700">|</span>
                                <button
                                  type="button"
                                  onClick={() => handleActionReject(action.id, true)}
                                  disabled={isLoading}
                                  className="text-stone-500 hover:text-red-400 disabled:opacity-50 transition"
                                >
                                  다시 제안하지 않기
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      const statusLabel: Record<string, { text: string; color: string }> = {
                        EXECUTED: { text: "실행됨", color: "text-emerald-400" },
                        REJECTED: { text: "거절됨", color: "text-stone-500" },
                        FAILED: { text: "실패", color: "text-red-400" },
                      };
                      const status = statusLabel[action.status];
                      if (!status) return null;

                      return (
                        <div className={`flex items-center gap-2 mt-2 text-xs ${status.color}`}>
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
                          {status.text}
                          <span className="text-stone-600">
                            {action.toolName.replace(/_/g, " ")}
                          </span>
                        </div>
                      );
                    })()}

                  {/* Actions */}
                  {editingMsgId !== msg.id && (
                    <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => copyMessage(msg.content)}
                        className="p-1.5 rounded-md text-stone-500 hover:text-stone-300 hover:bg-stone-800 transition"
                        title="복사"
                        aria-label="메시지 복사"
                      >
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                      {msg.role === "USER" && !streaming && (
                        <button
                          type="button"
                          onClick={() => startEditMessage(msg)}
                          className="p-1.5 rounded-md text-stone-500 hover:text-stone-300 hover:bg-stone-800 transition"
                          title="수정"
                          aria-label="메시지 수정"
                        >
                          <svg
                            aria-hidden="true"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                          </svg>
                        </button>
                      )}
                      {msg.role === "ASSISTANT" && (
                        <button
                          type="button"
                          onClick={() => retryMessage(idx)}
                          className="p-1.5 rounded-md text-stone-500 hover:text-stone-300 hover:bg-stone-800 transition"
                          title="다시 시도"
                          aria-label="답변 다시 시도"
                        >
                          <svg
                            aria-hidden="true"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Streaming */}
          {streaming && streamingContent && (
            <div className="py-5 border-t border-stone-800/30">
              <div className="flex gap-4">
                <div className="shrink-0 pt-0.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-300/25 bg-amber-300/10">
                    <img src="/brand/mark.svg?v=flow-5" alt="" className="h-5 w-5" />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-stone-300 mb-1.5">Jigeum</p>
                  <div className="text-[15px] text-stone-200 leading-relaxed">
                    <Markdown content={streamingContent} />
                    <span className="inline-block w-0.5 h-5 bg-stone-400 rounded-full animate-pulse ml-0.5 align-text-bottom" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tool calls */}
          {streaming && activeTools.length > 0 && (
            <div className="py-3">
              <div className="flex gap-4">
                <div className="w-7 shrink-0" />
                <div className="flex flex-wrap gap-2">
                  {activeTools.map((tool) => (
                    <span
                      key={tool}
                      className="inline-flex items-center gap-1.5 text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-full px-3 py-1"
                    >
                      <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
                      {tool.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Loading dots */}
          {streaming && !streamingContent && activeTools.length === 0 && (
            <div className="py-5 border-t border-stone-800/30">
              <div className="flex gap-4">
                <div className="shrink-0 pt-0.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-300/25 bg-amber-300/10">
                    <img src="/brand/mark.svg?v=flow-5" alt="" className="h-5 w-5" />
                  </div>
                </div>
                <div className="flex items-center gap-1.5 pt-2">
                  <span className="w-2 h-2 bg-stone-500 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-2 h-2 bg-stone-500 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-2 h-2 bg-stone-500 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Scroll to bottom */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth" })}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-stone-800 hover:bg-stone-700 border border-stone-600 text-stone-300 rounded-full w-9 h-9 flex items-center justify-center shadow-lg transition"
            aria-label="맨 아래로 이동"
          >
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
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 px-4 pb-4 pt-2">
        <div className="mx-auto max-w-4xl">
          {/* Suggestions */}
          {suggestions.length > 0 && !streaming && (
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    const userMsg: Message = {
                      id: crypto.randomUUID(),
                      role: "USER",
                      content: s,
                      createdAt: new Date().toISOString(),
                    };
                    setMessages((prev) => [...prev, userMsg]);
                    setSuggestions([]);
                    streamResponse(s);
                  }}
                  className="shrink-0 whitespace-nowrap rounded-full border border-stone-700/50 px-4 py-1.5 text-[13px] text-stone-400 transition hover:border-amber-500/35 hover:bg-amber-500/10 hover:text-stone-100"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Attachment preview */}
          {attachment && (
            <div className="flex items-center gap-2 mb-2 bg-stone-900 border border-stone-700/50 rounded-xl px-3 py-2 text-xs">
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-stone-400 shrink-0"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="text-stone-300 truncate flex-1">{attachment.name}</span>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                className="text-stone-500 hover:text-red-400 transition shrink-0 text-sm"
              >
                x
              </button>
            </div>
          )}

          {/* Skill picker dropdown */}
          {showSkillPicker && skillsList.length > 0 && (
            <div className="mb-2 rounded-xl bg-stone-900 border border-stone-700 overflow-hidden max-h-48 overflow-y-auto">
              {skillsList.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => selectSkill(skill)}
                  className="w-full text-left px-4 py-2.5 hover:bg-stone-800 transition flex items-center gap-3"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-yellow-500 shrink-0"
                  >
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  <div className="min-w-0">
                    <span className="text-sm text-white">{skill.name}</span>
                    {skill.description && (
                      <span className="text-xs text-stone-500 ml-2">{skill.description}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Input box */}
          <div className="rounded-2xl border border-stone-700/55 bg-stone-950/70 shadow-2xl shadow-black/20 transition focus-within:border-amber-500/45">
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="필요한 결정, 근거, 다음 액션을 요청하세요..."
              rows={1}
              className="w-full bg-transparent px-5 pt-4 pb-2 text-[15px] resize-none focus:outline-none placeholder-stone-500 max-h-[200px]"
            />
            <div className="flex items-center justify-between px-3 pb-3">
              <div className="flex items-center gap-1">
                <input
                  ref={fileRef}
                  type="file"
                  onChange={handleFileSelect}
                  accept=".txt,.md,.json,.csv,.yaml,.yml,.xml,.log,.js,.ts,.py,.html,.css"
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="p-2 rounded-lg text-stone-500 hover:text-stone-300 hover:bg-stone-800/50 transition"
                  title="파일 첨부"
                >
                  <svg
                    aria-hidden="true"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                <VoiceButton
                  onTranscript={(text) => {
                    setInput((prev) => (prev ? `${prev} ${text}` : text));
                    inputRef.current?.focus();
                  }}
                  className="p-2 rounded-lg"
                />
              </div>

              {streaming ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="p-2 rounded-lg bg-stone-700 hover:bg-stone-600 text-white transition"
                  title="중지"
                >
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={sendMessage}
                  disabled={!input.trim() && !attachment}
                  className="rounded-lg bg-amber-300 p-2 text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-stone-700 disabled:text-stone-500"
                  title="보내기"
                >
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
                </button>
              )}
            </div>
          </div>

          <p className="mt-2 text-center text-[11px] text-stone-600">
            Jigeum은 판단 근거를 먼저 준비하고, 실제 실행은 승인 뒤에 진행합니다.
          </p>
        </div>
      </div>
    </div>
  );
}
