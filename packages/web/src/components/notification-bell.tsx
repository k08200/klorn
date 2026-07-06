"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../lib/api";
import {
  getTypeLabel,
  groupNotifications,
  type NotificationGroup,
  unreadGroupCount,
} from "../lib/notification-grouping";
import { formatRelative } from "../lib/text";
import { RejectReasonDialog } from "./reject-reason-dialog";
import { useToast } from "./toast";
import { useWebSocket } from "./use-websocket";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  conversationId?: string | null;
  sourceEmailId?: string | null;
  pendingActionId?: string | null;
  pendingActionStatus?: string | null;
  link?: string | null;
}

const typeIcon: Record<string, string> = {
  reminder: "🔔",
  calendar: "📅",
  email: "📧",
  task: "✅",
  meeting: "🎥",
  briefing: "📋",
  insight: "🤖",
};

function isAgentNotification(title: string): boolean {
  const legacyPrefix = "[EV" + "E]";
  return title.startsWith("[Klorn]") || title.startsWith("[Eve]") || title.startsWith(legacyPrefix);
}

function notificationTitle(title: string): string {
  const legacyPrefix = "[EV" + "E]";
  if (title.startsWith("[Klorn]")) return title.slice(8).trim();
  if (title.startsWith("[Eve]")) return title.slice(5).trim();
  if (title.startsWith(legacyPrefix)) return title.slice(5).trim();
  return title;
}

export default function NotificationBell({ userId }: { userId: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  // Notification awaiting the reject-with-reason dialog; null when closed.
  const [rejectTarget, setRejectTarget] = useState<Notification | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  // True once the first list load has completed. Lets reconcile() tell a real
  // resume (flash on new items) apart from the initial paint (everything is
  // "new" then, but the user is already looking).
  const initializedRef = useRef(false);
  // Timestamp of the last reconcile fetch — collapses the focus +
  // visibilitychange burst that fires together when a tab is reactivated.
  const lastSyncRef = useRef(0);
  // Pending bell-flash timer. Tracked so a re-flash clears the prior timeout
  // and unmount clears it outright — otherwise a stale timer can fire
  // setFlash(false) onto a later mount and cancel its flash.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const { toast } = useToast();
  const { connected, on, connectedClients } = useWebSocket(userId);

  // Briefly animate the bell. Clears any in-flight timer first so overlapping
  // flashes don't leave a dangling timeout that cancels a later one.
  const triggerFlash = useCallback(() => {
    setFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setFlash(false);
      flashTimerRef.current = null;
    }, 2000);
  }, []);

  // Clear the flash timer on unmount so it can't fire onto a remounted instance.
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // Compute fixed position for dropdown based on bell button location.
  // On mobile we ignore the bell's x and span the viewport with an inset gutter;
  // anchoring to bell.x was pushing the 320px dropdown off the right edge,
  // which looked like a "half cut" drawer on iPhone.
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < 768);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    if (open && bellRef.current) {
      const rect = bellRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 8, left: rect.left });
    }
  }, [open]);

  // Click outside / Escape to close — check both bell container and portal dropdown.
  // While the reject-with-reason dialog is open it owns those interactions,
  // so the dropdown stays put underneath it.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rejectTarget) return;
      const target = e.target as Node;
      const inBell = containerRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inBell && !inDropdown) {
        setOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (rejectTarget) return;
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [open, rejectTarget]);

  // Bridge service-worker push events into the same refresh bus the WS uses:
  // when a push lands while the socket is down/backgrounded, the SW posts
  // conversations-updated and open pages still refetch their lists.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "conversations-updated") {
        window.dispatchEvent(new Event("conversations-updated"));
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  // Listen for real-time push notifications via WebSocket
  useEffect(() => {
    const unsub = on("notification", (payload) => {
      const notif = payload as unknown as Notification;

      // System event: trigger sidebar refresh
      if (notif.type === "system" && notif.title === "conversations-updated") {
        window.dispatchEvent(new Event("conversations-updated"));
        return;
      }

      if (notif.id) {
        // Track seen notification IDs to prevent duplicate desktop notifications
        if (seenIdsRef.current.has(notif.id)) return;
        seenIdsRef.current.add(notif.id);

        setNotifications((prev) => {
          if (prev.some((n) => n.id === notif.id)) return prev;
          return [{ ...notif, isRead: false }, ...prev];
        });

        triggerFlash();

        if (
          typeof window !== "undefined" &&
          "Notification" in window &&
          window.Notification.permission === "granted"
        ) {
          try {
            new window.Notification(notif.title, {
              body: notif.message,
              icon: "/icon-192.png",
              requireInteraction: true,
            });
          } catch {
            // Notification constructor failed — ignore
          }
        }
      }
    });
    return unsub;
  }, [on, triggerFlash]);

  // Pull the authoritative notification list from the server (source of truth).
  // WebSocket delivery is best-effort and lives only in server memory, so any
  // notification broadcast while this tab was suspended (laptop closed) or the
  // socket was down never reaches this client — it only lands in the DB.
  // Re-pulling here is what makes those notifications appear without a manual
  // refresh. flashOnNew animates the bell when the pull surfaces items we
  // hadn't recorded yet, so a resume is visibly signalled.
  const fetchNotifications = useCallback(
    (opts?: { flashOnNew?: boolean }) => {
      apiFetch<{ notifications: Notification[] }>("/api/notifications?limit=30")
        .then((d) => {
          const notifs = d.notifications || [];
          // Anything not yet in seenIds arrived while we were away. On the first
          // load every id is unseen, so the initializedRef guard suppresses the
          // flash for that paint only.
          const hasNew = notifs.some((n) => !seenIdsRef.current.has(n.id));
          // Seed seen IDs so fetched notifications don't re-trigger desktop alerts
          for (const n of notifs) seenIdsRef.current.add(n.id);
          setNotifications(notifs);
          if (opts?.flashOnNew && initializedRef.current && hasNew) {
            triggerFlash();
          }
          initializedRef.current = true;
        })
        .catch(() => {});
    },
    [triggerFlash],
  );

  // Re-sync with the server whenever the tab is reactivated, the network
  // returns, or the realtime socket reconnects. The 1s guard collapses the
  // focus + visibilitychange pair that fire together on reactivation. This is
  // the fix for "I had to refresh to see notifications after reopening my
  // laptop": resume now reconciles automatically instead of waiting on (or
  // missing) the 60s background poll.
  const reconcile = useCallback(() => {
    const now = Date.now();
    if (now - lastSyncRef.current < 1_000) return;
    lastSyncRef.current = now;
    fetchNotifications({ flashOnNew: true });
  }, [fetchNotifications]);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(() => fetchNotifications(), 60_000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reconcile]);

  // A socket (re)connection means broadcasts may have been missed while it was
  // down — pull the gap. `connected` flips false→true on first connect and on
  // every reconnect. The 1s throttle only collapses the mount + first-connect
  // burst at startup; a reconnect that lands seconds after a resume legitimately
  // fetches again, which is what we want (it may surface items that arrived in
  // between).
  useEffect(() => {
    if (connected) reconcile();
  }, [connected, reconcile]);

  const [actionLoading, setActionLoading] = useState(false);
  // Per-notification approve/reject loading state so buttons on other rows stay interactive
  const [pendingActionLoading, setPendingActionLoading] = useState<
    Record<string, "approve" | "reject" | null>
  >({});

  const handleApprovePendingAction = async (notif: Notification, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!notif.pendingActionId || pendingActionLoading[notif.id]) return;
    setPendingActionLoading((prev) => ({ ...prev, [notif.id]: "approve" }));
    try {
      await apiFetch(`/api/chat/pending-actions/${notif.pendingActionId}/approve`, {
        method: "POST",
      });
      // Optimistic update — mark action resolved and notification read so the row hides its buttons
      setNotifications((prev) =>
        prev.map((x) =>
          x.id === notif.id ? { ...x, pendingActionStatus: "EXECUTED", isRead: true } : x,
        ),
      );
      apiFetch(`/api/notifications/${notif.id}/read`, { method: "PATCH" }).catch(() => {});
    } catch (err) {
      console.error("[notification-bell] approve failed", err);
      // Let the user retry — don't silently swallow
      toast("Could not approve this action. Try again shortly.", "error");
    } finally {
      setPendingActionLoading((prev) => ({ ...prev, [notif.id]: null }));
    }
  };

  // Opens the reject-with-reason dialog; the actual API call happens in
  // performRejectPendingAction once the user confirms (reason optional).
  const handleRejectPendingAction = (notif: Notification, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!notif.pendingActionId || pendingActionLoading[notif.id]) return;
    setRejectTarget(notif);
  };

  const performRejectPendingAction = async (notif: Notification, reason: string | null) => {
    if (!notif.pendingActionId || pendingActionLoading[notif.id]) return;
    setPendingActionLoading((prev) => ({ ...prev, [notif.id]: "reject" }));
    try {
      await apiFetch(`/api/chat/pending-actions/${notif.pendingActionId}/reject`, {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      });
      setNotifications((prev) =>
        prev.map((x) =>
          x.id === notif.id ? { ...x, pendingActionStatus: "REJECTED", isRead: true } : x,
        ),
      );
      apiFetch(`/api/notifications/${notif.id}/read`, { method: "PATCH" }).catch(() => {});
    } catch (err) {
      console.error("[notification-bell] reject failed", err);
      toast("Could not reject this action. Try again shortly.", "error");
    } finally {
      setPendingActionLoading((prev) => ({ ...prev, [notif.id]: null }));
    }
  };

  // Determine where clicking a notification should navigate.
  // Week 1 removed /calendar, /tasks, /email, /notes — every fallback now
  // points at a surviving surface so taps never 404.
  const getNotificationTarget = (n: Notification): string | null => {
    if (n.link) return n.link;
    // A pending action the user still needs to approve/reject — Inbox is
    // the one place that shows every unresolved item with action buttons.
    if (n.pendingActionId && n.pendingActionStatus === "PENDING") return "/inbox";
    if (n.conversationId) return "/inbox";
    const typeRoutes: Record<string, string> = {
      briefing: "/briefing",
      meeting: "/briefing",
      calendar: "/briefing",
      email: "/briefing",
      task: "/inbox",
      reminder: "/inbox",
      insight: "/inbox",
    };
    return typeRoutes[n.type] || "/inbox";
  };

  const handleNotificationClick = (n: Notification) => {
    // Mark as read (fire-and-forget)
    if (!n.isRead) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      apiFetch(`/api/notifications/${n.id}/read`, { method: "PATCH" }).catch(() => {});
    }

    // Navigate first, then close dropdown
    const target = getNotificationTarget(n);
    if (target) {
      router.push(target);
      // Close dropdown after navigation starts (defer to avoid portal unmount racing with router)
      setTimeout(() => setOpen(false), 0);
    }
  };

  const markAllRead = async () => {
    setActionLoading(true);
    try {
      await apiFetch("/api/notifications/read-all", { method: "PATCH" });
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    } catch {
      fetchNotifications();
    } finally {
      setActionLoading(false);
    }
  };

  const clearAll = async () => {
    setActionLoading(true);
    try {
      await apiFetch("/api/notifications", { method: "DELETE" });
      setNotifications([]);
      setOpen(false);
    } catch {
      fetchNotifications();
    } finally {
      setActionLoading(false);
    }
  };

  const groups = useMemo(() => groupNotifications(notifications), [notifications]);
  const unreadCount = unreadGroupCount(groups);
  const tabCount = connectedClients.filter((c) => c.type === "web").length;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderItem = (n: Notification) => (
    // Plain container — the tappable summary is a real <button> sibling of the
    // Approve/Reject buttons, so no interactive element nests inside another
    // (the previous role="button" div wrapped the action buttons, which is an
    // invalid nested-interactive pattern for AT).
    <div
      key={n.id}
      className={`border-b border-stone-800/50 ${
        !n.isRead ? "bg-amber-400/5" : ""
      } ${isAgentNotification(n.title) ? "border-l-2 border-l-amber-300/60" : ""}`}
    >
      {/* The row itself is a real button (Enter + Space activate). Action buttons
          live in a sibling block below so we never nest interactive-in-interactive. */}
      <button
        type="button"
        onClick={() => handleNotificationClick(n)}
        className="focus-ring block w-full min-h-11 cursor-pointer px-4 py-3.5 md:py-3 text-left transition hover:bg-stone-800/50"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm">
            {isAgentNotification(n.title) ? "🤖" : typeIcon[n.type] || "📌"}
          </span>
          <span
            className={`text-sm truncate ${!n.isRead ? "font-semibold" : "text-stone-300"} ${isAgentNotification(n.title) ? "text-amber-200" : ""}`}
          >
            {notificationTitle(n.title)}
          </span>
          {isAgentNotification(n.title) && (
            <span className="text-[9px] text-amber-300 bg-amber-300/10 px-1 py-0.5 rounded shrink-0">
              Klorn
            </span>
          )}
          {!n.isRead && <span className="w-1.5 h-1.5 rounded-full bg-amber-300 shrink-0 ml-auto" />}
        </div>
        <p className="text-[13px] md:text-xs text-stone-400 mt-1 line-clamp-2 ml-6">{n.message}</p>
        <div className="flex items-center gap-2 mt-1 ml-6">
          <span className="text-[10px] text-stone-400">{formatRelative(n.createdAt)}</span>
          {getNotificationTarget(n) && <span className="text-[10px] text-amber-300">Open</span>}
        </div>
      </button>
      {n.pendingActionId && n.pendingActionStatus === "PENDING" && (
        <div className="flex items-center gap-2 px-4 pb-3 ml-6">
          <button
            type="button"
            onClick={(e) => handleApprovePendingAction(n, e)}
            disabled={!!pendingActionLoading[n.id]}
            className="focus-ring text-sm md:text-[11px] px-4 py-2 md:px-2.5 md:py-1 rounded-md md:rounded bg-amber-400 hover:bg-amber-300 disabled:bg-stone-700 disabled:text-stone-500 disabled:cursor-not-allowed text-stone-950 font-medium transition min-w-[72px] md:min-w-0"
          >
            {pendingActionLoading[n.id] === "approve" ? "..." : "Approve"}
          </button>
          <button
            type="button"
            onClick={(e) => handleRejectPendingAction(n, e)}
            disabled={!!pendingActionLoading[n.id]}
            className="focus-ring text-sm md:text-[11px] px-4 py-2 md:px-2.5 md:py-1 rounded-md md:rounded bg-stone-800 hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed text-stone-300 font-medium transition min-w-[72px] md:min-w-0"
          >
            {pendingActionLoading[n.id] === "reject" ? "..." : "Reject"}
          </button>
        </div>
      )}
      {n.pendingActionId && n.pendingActionStatus && n.pendingActionStatus !== "PENDING" && (
        <div className="px-4 pb-2 ml-6">
          <span className="text-[10px] text-stone-400">
            {n.pendingActionStatus === "EXECUTED"
              ? "Done"
              : n.pendingActionStatus === "REJECTED"
                ? "Rejected"
                : n.pendingActionStatus}
          </span>
        </div>
      )}
    </div>
  );

  const renderGroupHeader = (group: NotificationGroup<Notification>, expanded: boolean) => {
    const label = `${group.isAgent ? "Klorn " : ""}${getTypeLabel(group.type)}`;
    return (
      <button
        key={`${group.key}_header`}
        type="button"
        onClick={() => toggleGroup(group.key)}
        className={`focus-ring w-full min-h-11 text-left px-4 py-3 border-b border-stone-800/50 hover:bg-stone-800/50 transition ${
          group.unreadCount > 0 ? "bg-amber-400/5" : ""
        } ${group.isAgent ? "border-l-2 border-l-amber-300/60" : ""}`}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm">{group.isAgent ? "🤖" : typeIcon[group.type] || "📌"}</span>
          <span
            className={`text-sm ${group.unreadCount > 0 ? "font-semibold" : "text-stone-300"} ${group.isAgent ? "text-amber-200" : ""}`}
          >
            {label} {group.items.length}
          </span>
          {group.unreadCount > 0 && (
            <span className="text-[10px] text-amber-200 bg-amber-300/10 px-1.5 py-0.5 rounded shrink-0">
              New {group.unreadCount}
            </span>
          )}
          <span className="text-[10px] text-stone-500 ml-auto shrink-0">
            {expanded ? "Collapse" : "Expand"}
          </span>
        </div>
        <p className="text-[13px] md:text-xs text-stone-400 mt-1 line-clamp-1 ml-6">
          {notificationTitle(group.latestItem.title)}
        </p>
        <p className="text-[10px] text-stone-400 mt-1 ml-6">
          Latest {formatRelative(group.latestItem.createdAt)}
        </p>
      </button>
    );
  };

  return (
    <div className="relative flex items-center gap-2" ref={containerRef}>
      {/* Connection indicator */}
      <span
        className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400" : "bg-stone-600"}`}
        title={connected ? `Connected${tabCount > 1 ? ` (${tabCount} tabs)` : ""}` : "Disconnected"}
      />

      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={`focus-ring relative rounded-md text-stone-400 hover:text-white transition p-1 ${flash ? "animate-bounce" : ""}`}
        aria-label="Notifications"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            style={
              isMobile
                ? {
                    position: "fixed",
                    top: dropdownPos.top,
                    left: 8,
                    right: 8,
                    zIndex: 9999,
                  }
                : {
                    position: "fixed",
                    top: dropdownPos.top,
                    left: dropdownPos.left,
                    zIndex: 9999,
                  }
            }
            className="md:w-[min(20rem,calc(100vw-2rem))] bg-stone-900 border border-stone-700 rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[min(70vh,calc(100vh-6rem))] md:max-h-[28rem]"
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Notifications</span>
                {connected && (
                  <span className="text-[10px] text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">
                    Live
                  </span>
                )}
                {unreadCount > 0 && (
                  <span className="text-[10px] text-amber-300 bg-amber-300/10 px-1.5 py-0.5 rounded">
                    {unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    disabled={actionLoading}
                    className="text-xs text-stone-500 hover:text-amber-300 transition disabled:opacity-40"
                  >
                    {actionLoading ? "..." : "Mark all read"}
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    disabled={actionLoading}
                    className="text-xs text-stone-500 hover:text-red-400 transition disabled:opacity-40"
                  >
                    {actionLoading ? "..." : "Clear"}
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {notifications.length === 0 ? (
                <p className="text-center text-stone-500 text-sm py-6">No new notifications</p>
              ) : (
                groups.map((group) => {
                  if (group.items.length === 1) return renderItem(group.items[0]);
                  const expanded = expandedGroups.has(group.key);
                  return (
                    <div key={group.key}>
                      {renderGroupHeader(group, expanded)}
                      {expanded && group.items.map(renderItem)}
                    </div>
                  );
                })
              )}
            </div>
            {tabCount > 1 && (
              <div className="px-4 py-2 border-t border-stone-800 text-[10px] text-stone-500">
                {tabCount} tabs connected
              </div>
            )}
          </div>,
          document.body,
        )}

      <RejectReasonDialog
        open={rejectTarget !== null}
        onCancel={() => setRejectTarget(null)}
        onReject={(reason) => {
          const notif = rejectTarget;
          setRejectTarget(null);
          if (notif) void performRejectPendingAction(notif, reason);
        }}
      />
    </div>
  );
}
