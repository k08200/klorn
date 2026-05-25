"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, apiFetch, authHeaders } from "../lib/api";
import { useAuth } from "../lib/auth";
import { captureClientError } from "../lib/sentry";
import NotificationBell from "./notification-bell";
import { useToast } from "./toast";

interface Conversation {
  id: string;
  title: string | null;
  pinned: boolean;
  source?: string; // "user" | "agent"
  updatedAt: string;
  _count: { messages: number };
  pendingActionCount?: number;
}

interface DateGroup {
  label: string;
  items: Conversation[];
}

function renderHighlighted(
  text: string,
  highlights?: { start: number; end: number }[],
): React.ReactNode {
  if (!highlights || highlights.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  highlights.forEach((h, i) => {
    if (h.start < cursor || h.end > text.length || h.end <= h.start) return;
    if (h.start > cursor) parts.push(text.slice(cursor, h.start));
    parts.push(
      <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded-sm px-0.5">
        {text.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function groupByDate(convs: Conversation[]): DateGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const monthAgo = new Date(today.getTime() - 30 * 86400000);

  const groups: DateGroup[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Last 7 days", items: [] },
    { label: "Last 30 days", items: [] },
    { label: "Older", items: [] },
  ];

  for (const conv of convs) {
    const d = new Date(conv.updatedAt);
    if (d >= today) groups[0].items.push(conv);
    else if (d >= yesterday) groups[1].items.push(conv);
    else if (d >= weekAgo) groups[2].items.push(conv);
    else if (d >= monthAgo) groups[3].items.push(conv);
    else groups[4].items.push(conv);
  }

  return groups.filter((g) => g.items.length > 0);
}

const NAV_ITEMS = [
  { href: "/inbox", label: "Decision queue", icon: "check" },
  { href: "/ledger", label: "Ledger", icon: "list" },
  { href: "/email", label: "Mail", icon: "mail" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/briefing", label: "Briefing", icon: "bell" },
];

// Threads whose entire title is shorter than this are treated as dev noise
// (e.g. "hi", "ok", a stray Hangul jamo) and hidden from the sidebar list.
// Pinned threads and search results bypass the filter, so users can still
// reach a short-titled thread when they want it.
const MIN_TITLE_LENGTH = 3;
// Common test/noise titles that exceed MIN_TITLE_LENGTH but are still clearly
// disposable. Compared case-insensitively against the trimmed title.
const NOISE_TITLES = new Set(["test", "asdf", "qwer", "테스트", "test1", "test2"]);

function hasMeaningfulTitle(conv: { title: string | null }): boolean {
  const title = (conv.title ?? "").trim();
  if (title.length < MIN_TITLE_LENGTH) return false;
  return !NOISE_TITLES.has(title.toLowerCase());
}

function NavIcon({ type, size = 16 }: { type: string; size?: number }) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (type) {
    case "grid":
      return (
        <svg aria-hidden="true" {...props}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      );
    case "mail":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      );
    case "check":
      return (
        <svg aria-hidden="true" {...props}>
          <polyline points="9 11 12 14 22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "list":
      return (
        <svg aria-hidden="true" {...props}>
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      );
    case "calendar":
      return (
        <svg aria-hidden="true" {...props}>
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case "file":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
    case "user":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      );
    case "bell":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case "zap":
      return (
        <svg aria-hidden="true" {...props}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "flag":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
      );
    case "check-square":
      return (
        <svg aria-hidden="true" {...props}>
          <polyline points="3 17 5 19 9 15" />
          <polyline points="3 11 5 13 9 9" />
          <polyline points="3 5 5 7 9 3" />
          <line x1="13" y1="6" x2="21" y2="6" />
          <line x1="13" y1="12" x2="21" y2="12" />
          <line x1="13" y1="18" x2="21" y2="18" />
        </svg>
      );
    case "settings":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
}

export default function Sidebar({
  mobileOpen,
  onMobileClose,
  compact = false,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
  /**
   * Stadium mode for /inbox: hide the search bar and the conversation
   * list so the user keeps their focus on the decision hero. The
   * workspace nav, brand mark, and user menu stay visible so other
   * destinations are still reachable in one click.
   */
  compact?: boolean;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [search, setSearch] = useState("");
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(() => {
    if (authLoading || !user) {
      setConversations([]);
      return;
    }
    apiFetch<{ conversations: Conversation[] }>("/api/chat/conversations")
      .then((data) => setConversations(data.conversations))
      .catch((err) => captureClientError(err, { scope: "sidebar.load-conversations" }));
  }, [authLoading, user]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Reload conversations when navigating to a chat page (new chat created)
  useEffect(() => {
    if (pathname.startsWith("/chat")) {
      loadConversations();
    }
  }, [pathname, loadConversations]);

  // Reload when chat page signals title update
  useEffect(() => {
    const handler = () => {
      setTimeout(loadConversations, 1500);
    };
    window.addEventListener("conversations-updated", handler);
    return () => window.removeEventListener("conversations-updated", handler);
  }, [loadConversations]);

  // Close user menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const createChat = async () => {
    if (creatingChat) return;
    setCreatingChat(true);
    try {
      const conv = await apiFetch<{ id: string }>("/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({}),
      });
      router.push(`/chat/${conv.id}`);
      onMobileClose();
    } catch (err) {
      captureClientError(err, { scope: "sidebar.create-chat" });
      toast("Could not create a thread. Check your connection.", "error");
    } finally {
      setCreatingChat(false);
    }
  };

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<
    {
      messageId: string;
      conversationId: string;
      conversationTitle: string;
      content: string;
      highlights?: { start: number; end: number }[];
    }[]
  >([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Full-text search across message content (Claude Code-inspired deep search)
  useEffect(() => {
    if (search.length < 2) {
      setSearchResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      apiFetch<{
        results: {
          messageId: string;
          conversationId: string;
          conversationTitle: string;
          content: string;
          highlights?: { start: number; end: number }[];
        }[];
      }>(`/api/chat/search?q=${encodeURIComponent(search)}`)
        .then((data) => setSearchResults(data.results))
        .catch(() => setSearchResults([]));
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search]);

  const deleteConversation = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error();
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setDeleteConfirm(null);
      if (pathname === `/chat/${id}`) {
        router.push("/chat");
      }
    } catch {
      toast("Could not delete the thread.", "error");
      setDeleteConfirm(null);
    }
  };

  const confirmDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    setDeleteConfirm(id);
  };

  const startRename = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingId(conv.id);
    setEditTitle(conv.title || "");
  };

  const saveRename = async (e: React.FormEvent, id: string) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ title: editTitle }),
      });
      if (!res.ok) throw new Error();
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: editTitle } : c)));
    } catch {
      toast("Could not rename the thread.", "error");
    }
    setEditingId(null);
  };

  const togglePin = async (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation();
    e.preventDefault();
    const newPinned = !conv.pinned;
    setConversations((prev) =>
      prev.map((c) => (c.id === conv.id ? { ...c, pinned: newPinned } : c)),
    );
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conv.id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ pinned: newPinned }),
      });
      if (!res.ok) throw new Error();
    } catch {
      // Rollback on failure
      setConversations((prev) =>
        prev.map((c) => (c.id === conv.id ? { ...c, pinned: !newPinned } : c)),
      );
      toast("Could not update pinned state.", "error");
    }
  };

  const activeConvId = pathname.startsWith("/chat/") ? pathname.split("/chat/")[1] : null;
  const filtered = search
    ? conversations.filter((c) => (c.title || "").toLowerCase().includes(search.toLowerCase()))
    : conversations;
  // Separate agent suggestions (with pending actions) from regular conversations
  const agentSuggestions = filtered.filter(
    (c) => c.source === "agent" && (c.pendingActionCount || 0) > 0,
  );
  const regularConvs = filtered.filter(
    (c) => !(c.source === "agent" && (c.pendingActionCount || 0) > 0),
  );
  const totalPending = agentSuggestions.reduce((sum, c) => sum + (c.pendingActionCount || 0), 0);
  const pinned = regularConvs.filter((c) => c.pinned);
  // Hide dev-noise threads ("hi", "ok", whitespace, empty) from the unpinned
  // list unless the user is actively searching. Pinned threads stay visible
  // regardless because the user explicitly chose to keep them.
  const unpinnedAll = regularConvs.filter((c) => !c.pinned);
  const unpinned = search ? unpinnedAll : unpinnedAll.filter(hasMeaningfulTitle);
  const groups = groupByDate(
    [...unpinned].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
  );

  const initials = user
    ? (user.name || user.email)
        .split(/[\s@]/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0].toUpperCase())
        .join("")
    : "";

  const sidebarContent = (
    <div className="relative flex h-full flex-col overflow-hidden border-r border-stone-800 bg-[#111318] pt-safe pb-safe">
      {/* Header */}
      <div className="relative flex items-center justify-between px-3 py-3">
        <Link
          href="/inbox"
          aria-label="Open decision queue"
          className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-stone-100 transition hover:text-white"
          onClick={onMobileClose}
        >
          <img src="/brand/mark.svg?v=flow-5" alt="" className="h-7 w-7" />
          <span>
            <span className="block leading-none">Klorn</span>
            <span className="mt-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
              Decision queue
            </span>
          </span>
        </Link>
        <div className="flex items-center gap-1">
          {user && <NotificationBell userId={user.id} />}
          <button
            type="button"
            onClick={createChat}
            disabled={creatingChat}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-stone-700 bg-stone-900 text-stone-400 transition hover:border-stone-600 hover:bg-stone-800 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="New decision thread"
            aria-label={creatingChat ? "Creating decision thread" : "New decision thread"}
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
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className={`relative px-3 pb-2 ${compact ? "hidden" : ""}`}>
        <div className="relative">
          <svg
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500 w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search decision threads..."
            className="w-full rounded-md border border-stone-700 bg-[#0f1115] py-1.5 pl-8 pr-3 text-xs text-stone-300 placeholder-stone-600 transition focus:border-stone-500 focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300 text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Conversation list — hidden in compact (Stadium) mode */}
      <div className={`relative ${compact ? "hidden" : "flex-1 overflow-y-auto"} px-2 pb-2`}>
        {/* Decision queue threads with pending actions */}
        {agentSuggestions.length > 0 && (
          <div className="mb-3">
            <Link
              href="/inbox"
              onClick={onMobileClose}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-stone-400 transition hover:bg-stone-800 hover:text-stone-100"
            >
              <span className="h-2 w-2 rounded-full bg-accent-light" />
              Decision queue
              {totalPending > 0 && (
                <span className="ml-auto rounded-full bg-stone-800 px-1.5 py-0.5 text-[10px] font-semibold text-stone-300">
                  {totalPending}
                </span>
              )}
            </Link>
            {agentSuggestions.map((conv) => {
              const isActive = activeConvId === conv.id;
              return (
                <Link
                  key={conv.id}
                  href={`/chat/${conv.id}`}
                  onClick={onMobileClose}
                  className={`group flex items-center gap-2 rounded-md px-2 py-2 text-sm transition ${
                    isActive
                      ? "bg-stone-800 text-white"
                      : "text-stone-400 hover:bg-stone-800/70 hover:text-stone-100"
                  }`}
                >
                  <span className="truncate flex-1 text-[13px]">
                    {conv.title || "Decision card"}
                  </span>
                  {(conv.pendingActionCount || 0) > 0 && (
                    <span className="shrink-0 rounded-full bg-stone-900 px-1.5 py-0.5 text-[10px] text-stone-300">
                      Pending {conv.pendingActionCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}

        {/* Deep search results (message content search) */}
        {searchResults.length > 0 && (
          <div className="mb-3">
            <p className="text-[11px] font-medium text-stone-500 px-2 py-1.5">Found in threads</p>
            {searchResults.slice(0, 5).map((r) => (
              <Link
                key={r.messageId}
                href={`/chat/${r.conversationId}`}
                onClick={onMobileClose}
                className="block rounded-lg px-2 py-2 text-sm text-stone-400 hover:bg-stone-800/50 hover:text-stone-200 transition"
              >
                <p className="text-[12px] text-stone-300 truncate font-medium">
                  {r.conversationTitle}
                </p>
                <p className="text-[11px] text-stone-500 truncate mt-0.5">
                  {renderHighlighted(r.content, r.highlights)}
                </p>
              </Link>
            ))}
          </div>
        )}

        {pinned.length > 0 && (
          <div className="mb-3">
            <p className="text-[11px] font-medium text-stone-500 px-2 py-1.5 flex items-center gap-1">
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
              >
                <path d="M16 2l5 5-3.2 3.2 1.2 7.8-4-4-4 4 1.2-7.8L9 7l5-5z" />
              </svg>
              Pinned
            </p>
            {pinned.map((conv) => {
              const isActive = activeConvId === conv.id;
              return (
                <div key={conv.id} className="relative group/conv">
                  {editingId === conv.id ? (
                    <form onSubmit={(e) => saveRename(e, conv.id)} className="px-2 py-1">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => setEditingId(null)}
                        className="w-full bg-stone-800 border border-stone-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-stone-500"
                      />
                    </form>
                  ) : (
                    <Link
                      href={`/chat/${conv.id}`}
                      onClick={onMobileClose}
                      className={`group flex items-center gap-2 rounded-md px-2 py-2 text-sm transition ${
                        isActive
                          ? "bg-stone-800 text-white"
                          : "text-stone-400 hover:bg-stone-800/70 hover:text-stone-200"
                      }`}
                    >
                      <span className="truncate flex-1 text-[13px] flex items-center gap-1.5">
                        {conv.source === "agent" && (
                          <span
                            className="w-2 h-2 rounded-full bg-stone-500 shrink-0"
                            title="Decision card"
                          />
                        )}
                        {conv.title || "New decision thread"}
                      </span>
                      <span
                        className={`hidden md:flex items-center gap-0.5 shrink-0 ${isActive ? "md:visible" : "md:invisible md:group-hover/conv:visible"}`}
                      >
                        <button
                          type="button"
                          onClick={(e) => togglePin(e, conv)}
                          className="p-0.5 text-yellow-500 hover:text-yellow-400 transition"
                          title="Unpin"
                        >
                          <svg
                            aria-hidden="true"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            stroke="none"
                          >
                            <path d="M16 2l5 5-3.2 3.2 1.2 7.8-4-4-4 4 1.2-7.8L9 7l5-5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => startRename(e, conv)}
                          className="p-0.5 text-stone-500 hover:text-stone-300 transition"
                          title="Rename"
                        >
                          <svg
                            aria-hidden="true"
                            width="12"
                            height="12"
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
                        <button
                          type="button"
                          onClick={(e) => confirmDelete(e, conv.id)}
                          className="p-0.5 text-stone-500 hover:text-red-400 transition"
                          title="Delete"
                        >
                          <svg
                            aria-hidden="true"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => confirmDelete(e, conv.id)}
                        className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 -mr-2 text-stone-500 active:text-red-400 transition shrink-0"
                        aria-label="Delete thread"
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
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {groups.map((group) => (
          <div key={group.label} className="mb-3">
            <p className="text-[11px] font-medium text-stone-500 px-2 py-1.5">{group.label}</p>
            {group.items.map((conv) => {
              const isActive = activeConvId === conv.id;
              return (
                <div key={conv.id} className="relative group/conv">
                  {editingId === conv.id ? (
                    <form onSubmit={(e) => saveRename(e, conv.id)} className="px-2 py-1">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => setEditingId(null)}
                        className="w-full bg-stone-800 border border-stone-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-stone-500"
                      />
                    </form>
                  ) : (
                    <Link
                      href={`/chat/${conv.id}`}
                      onClick={onMobileClose}
                      className={`group flex items-center gap-2 rounded-md px-2 py-2 text-sm transition ${
                        isActive
                          ? "bg-stone-800 text-white"
                          : "text-stone-400 hover:bg-stone-800/70 hover:text-stone-200"
                      }`}
                    >
                      <span className="truncate flex-1 text-[13px] flex items-center gap-1.5">
                        {conv.source === "agent" && (
                          <span
                            className="w-2 h-2 rounded-full bg-stone-500 shrink-0"
                            title="Decision card"
                          />
                        )}
                        {conv.title || "New decision thread"}
                      </span>
                      <span
                        className={`hidden md:flex items-center gap-0.5 shrink-0 ${isActive ? "md:visible" : "md:invisible md:group-hover/conv:visible"}`}
                      >
                        <button
                          type="button"
                          onClick={(e) => togglePin(e, conv)}
                          className="p-0.5 text-stone-500 hover:text-yellow-500 transition"
                          title="Pin"
                        >
                          <svg
                            aria-hidden="true"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M16 2l5 5-3.2 3.2 1.2 7.8-4-4-4 4 1.2-7.8L9 7l5-5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => startRename(e, conv)}
                          className="p-0.5 text-stone-500 hover:text-stone-300 transition"
                          title="Rename"
                        >
                          <svg
                            aria-hidden="true"
                            width="12"
                            height="12"
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
                        <button
                          type="button"
                          onClick={(e) => confirmDelete(e, conv.id)}
                          className="p-0.5 text-stone-500 hover:text-red-400 transition"
                          title="Delete"
                        >
                          <svg
                            aria-hidden="true"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => confirmDelete(e, conv.id)}
                        className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 -mr-2 text-stone-500 active:text-red-400 transition shrink-0"
                        aria-label="Delete thread"
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
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {filtered.length === 0 && (
          <p className="text-xs text-stone-600 px-3 py-4">
            {search ? "No matching threads." : "No decision threads yet."}
          </p>
        )}
      </div>

      {/* Flex spacer keeps Workspace nav pinned to the bottom when the
          conversation list is hidden (Stadium mode). */}
      {compact && <div aria-hidden="true" className="flex-1" />}

      {/* Workspace nav */}
      <div className="relative border-t border-stone-800 px-2 py-2">
        <div className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const badge = item.href === "/inbox" && totalPending > 0 ? totalPending : null;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onMobileClose}
                className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
                  pathname.startsWith(item.href)
                    ? "bg-stone-800 text-stone-100"
                    : "text-stone-500 hover:bg-stone-800/70 hover:text-stone-300"
                }`}
              >
                <NavIcon type={item.icon} size={14} />
                <span className="flex-1">{item.label}</span>
                {badge !== null && (
                  <span className="rounded-full bg-stone-900 px-1.5 py-0.5 text-[10px] font-semibold text-stone-300">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
          {user?.role === "ADMIN" && (
            <Link
              href="/admin"
              onClick={onMobileClose}
              className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition ${
                pathname.startsWith("/admin")
                  ? "bg-stone-800/80 text-white"
                  : "text-stone-500 hover:bg-stone-800/50 hover:text-stone-300"
              }`}
            >
              <NavIcon type="settings" size={14} />
              Admin
            </Link>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm rounded-lg">
          <div className="bg-stone-900 border border-stone-700 rounded-xl p-4 mx-4 shadow-2xl max-w-[220px]">
            <p className="text-sm text-stone-200 mb-3">Delete this thread?</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-3 py-1.5 text-xs text-stone-400 bg-stone-800 hover:bg-stone-700 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteConversation(deleteConfirm)}
                className="flex-1 px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 rounded-lg transition"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User */}
      <div className="border-t border-stone-800/40 p-2" ref={userMenuRef}>
        {authLoading ? (
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-stone-800" />
            <div className="h-3 w-24 animate-pulse rounded bg-stone-800" />
          </div>
        ) : user ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowUserMenu((p) => !p)}
              className="w-full flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-stone-800/50 transition text-left"
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-amber-300 to-stone-700 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-stone-300 truncate">{user.name || user.email}</p>
              </div>
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-stone-500 shrink-0"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {showUserMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-stone-900 border border-stone-700 rounded-xl shadow-2xl shadow-black/60 z-50 py-1 animate-slide-up">
                <Link
                  href="/settings"
                  onClick={() => {
                    setShowUserMenu(false);
                    onMobileClose();
                  }}
                  className="block px-3 py-2 text-sm text-stone-300 hover:bg-stone-800 rounded-md mx-1 transition"
                >
                  Settings
                </Link>
                <div className="border-t border-stone-800 my-1" />
                <button
                  type="button"
                  onClick={() => {
                    setShowUserMenu(false);
                    logout();
                  }}
                  className="w-[calc(100%-0.5rem)] text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-md mx-1 transition"
                >
                  Log out
                </button>
              </div>
            )}
          </div>
        ) : (
          <Link
            href="/login"
            className="flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-400 hover:bg-stone-800/50 hover:text-white transition"
          >
            Log in
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-[260px] h-dvh shrink-0 sticky top-0">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={onMobileClose} />
          <aside className="fixed inset-y-0 left-0 w-[280px] max-w-[85vw] z-50 md:hidden animate-slide-in-left pl-safe">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
