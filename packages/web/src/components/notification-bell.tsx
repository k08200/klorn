"use client";

import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { postReminder } from "../app/email/_v2/post-reminder";
import { REMINDER_LABEL_KEYS, type ReminderKey } from "../app/email/_v2/reminders";
import { apiFetch } from "../lib/api";
import { isEntitlementRefusal } from "../lib/entitlement";
import { useT } from "../lib/i18n";
import { deliverInPageAlert } from "../lib/in-page-notify";
import { openExternal, shellKind } from "../lib/native/shell";
import { catchUpDesktopAlerts, deliverDesktopAlert } from "../lib/native/tauri-notify";
import {
  bellBadgeCount,
  type CenterNotification,
  groupForCenter,
  type NotifBudget,
  parseNotifBudget,
} from "../lib/notification-center";
import { notificationClickTarget } from "../lib/notification-target";
import { AlertStrip } from "./notification-center/alert-strip";
import { NotificationRow, type RowBusy } from "./notification-center/notification-row";
import { MoreGlyph } from "./notification-center/type-icon";
import { useDeliveredTo } from "./notification-center/use-delivered-to";
import { ProFeatureNotice } from "./pro-feature-notice";
import { RejectReasonDialog } from "./reject-reason-dialog";
import { useToast } from "./toast";
import { useWebSocket } from "./use-websocket";

type Notification = CenterNotification;

const LATER_KEY: ReminderKey = "later-today";
const ROW_SELECTOR = "[data-nc-row]";

export default function NotificationBell({ userId }: { userId: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [budget, setBudget] = useState<NotifBudget | null>(null);
  // The header's overflow menu (holds "Clear").
  const [menuOpen, setMenuOpen] = useState(false);
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
  const { t } = useT();
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
    // The bell lives in the rail (600px+) and the sidebar; below 600px is
    // the full-width fallback (globals.css, --breakpoint-rail).
    const update = () => setIsMobile(window.innerWidth < 600);
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
    // Esc closes the overflow menu first, then the panel, and hands focus
    // back to the bell.
    const escHandler = (e: KeyboardEvent) => {
      if (rejectTarget || e.key !== "Escape") return;
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      setOpen(false);
      bellRef.current?.focus();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [open, rejectTarget, menuOpen]);

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
        // Windows desktop shell: banner server-tagged PUSH / meeting frames
        // (lib/native/desktop-catchup.ts — a per-account ledger shared with
        // catch-up). Runs before the seen check below: a list refetch can
        // record this id before the frame arrives, and that must not swallow
        // the banner.
        if (shellKind() === "tauri") void deliverDesktopAlert(userId, payload);

        // Track seen notification IDs to prevent duplicate desktop notifications
        if (seenIdsRef.current.has(notif.id)) return;
        seenIdsRef.current.add(notif.id);

        setNotifications((prev) => {
          if (prev.some((n) => n.id === notif.id)) return prev;
          return [{ ...notif, isRead: false }, ...prev];
        });

        triggerFlash();

        // Browser tab: an OS notification only for server-tagged PUSH /
        // meeting frames (the user's notification gate already passed), and
        // only when the service worker will not show it from Web Push
        // (lib/in-page-alerts.ts). Every other frame only updates the bell.
        // No-op inside the Tauri shell, which banners above.
        void deliverInPageAlert(payload);
      }
    });
    return unsub;
  }, [on, triggerFlash, userId]);

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
          // The daily alert budget shows only if this response already carries it.
          setBudget(parseNotifBudget(d));
          // Anything not yet in seenIds arrived while we were away. On the first
          // load every id is unseen, so the initializedRef guard suppresses the
          // flash for that paint only.
          const hasNew = notifs.some((n) => !seenIdsRef.current.has(n.id));
          // Seed seen IDs so fetched notifications don't re-trigger desktop alerts
          for (const n of notifs) seenIdsRef.current.add(n.id);
          setNotifications(notifs);
          // Windows desktop shell: frames sent while the app was quit, asleep
          // or disconnected are gone (the socket has no replay), so banner the
          // PUSH / meeting rows not announced yet — capped, fresh only, silent
          // on the first run (lib/native/desktop-catchup.ts).
          if (shellKind() === "tauri") void catchUpDesktopAlerts(userId, notifs);
          if (opts?.flashOnNew && initializedRef.current && hasNew) {
            triggerFlash();
          }
          initializedRef.current = true;
        })
        .catch(() => {});
    },
    [triggerFlash, userId],
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
  // Per-row busy state so actions on other rows stay interactive.
  const [rowBusy, setRowBusy] = useState<Record<string, RowBusy>>({});
  // Approving executes the action, which is Pro: a FREE user's 403 shows the notice.
  const [approveProGated, setApproveProGated] = useState(false);
  const titleId = useId();
  const menuId = useId();

  const setBusy = (id: string, busy: RowBusy) => setRowBusy((prev) => ({ ...prev, [id]: busy }));

  const markRead = (n: Notification) => {
    if (n.isRead) return;
    setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
    apiFetch(`/api/notifications/${n.id}/read`, { method: "PATCH" }).catch((err: unknown) =>
      console.error("[notification-bell] mark read failed", err),
    );
  };

  const closePanel = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    setOpen(false);
    if (restoreFocus) bellRef.current?.focus();
  }, []);

  const handleApprovePendingAction = async (notif: Notification) => {
    if (!notif.pendingActionId || rowBusy[notif.id]) return;
    setBusy(notif.id, "approve");
    setApproveProGated(false);
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
      if (isEntitlementRefusal(err)) {
        setApproveProGated(true);
        return;
      }
      console.error("[notification-bell] approve failed", err);
      toast(t("notif.toast.approveFailed"), "error");
    } finally {
      setBusy(notif.id, null);
    }
  };

  // Opens the reject-with-reason dialog; the actual API call happens in
  // performRejectPendingAction once the user confirms (reason optional).
  const handleRejectPendingAction = (notif: Notification) => {
    if (!notif.pendingActionId || rowBusy[notif.id]) return;
    setRejectTarget(notif);
  };

  const performRejectPendingAction = async (notif: Notification, reason: string | null) => {
    if (!notif.pendingActionId || rowBusy[notif.id]) return;
    setBusy(notif.id, "reject");
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
      toast(t("notif.toast.rejectFailed"), "error");
    } finally {
      setBusy(notif.id, null);
    }
  };

  const openExternalUrl = (url: string) => {
    // Never the app tab: an https link (e.g. a meeting) opens on its own —
    // in the system browser inside the desktop/mobile wrappers, where a
    // plain window.open may stay in the WebView or do nothing.
    if (shellKind() !== null) {
      openExternal(url).catch((err) =>
        console.error("[notifications] could not open external link:", err),
      );
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const handleNotificationClick = (n: Notification) => {
    markRead(n);
    // A stored link is untrusted (a meeting link can come from anyone's
    // invite): lib/notification-target.ts follows only a same-origin path or
    // a plain https URL.
    const target = notificationClickTarget(n);
    if (target.kind === "external") openExternalUrl(target.url);
    else router.push(target.path);
    // Close after navigation starts (defer to avoid portal unmount racing with router)
    setTimeout(() => closePanel(false), 0);
  };

  const handleReply = (n: Notification) => {
    if (!n.sourceEmailId) return;
    markRead(n);
    router.push(`/email/${encodeURIComponent(n.sourceEmailId)}?focus=reply`);
    setTimeout(() => closePanel(false), 0);
  };

  const handleJoin = (n: Notification, url: string) => {
    markRead(n);
    openExternalUrl(url);
  };

  // The mail's existing Later (POST /api/email/:id/later), same as the reader.
  const handleLater = async (n: Notification) => {
    if (!n.sourceEmailId || rowBusy[n.id]) return;
    setBusy(n.id, "later");
    try {
      await postReminder(n.sourceEmailId, LATER_KEY);
      markRead(n);
      toast(t("mailV2.list.remind.set", { when: t(REMINDER_LABEL_KEYS[LATER_KEY]) }), "success");
    } catch (err) {
      console.error("[notification-bell] later failed", err);
      toast(t("mailV2.list.remind.failed"), "error");
    } finally {
      setBusy(n.id, null);
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
    setMenuOpen(false);
    setActionLoading(true);
    try {
      await apiFetch("/api/notifications", { method: "DELETE" });
      setNotifications([]);
      closePanel(true);
    } catch {
      fetchNotifications();
    } finally {
      setActionLoading(false);
    }
  };

  const groups = useMemo(() => groupForCenter(notifications), [notifications]);
  const badgeCount = bellBadgeCount(notifications);
  const unreadTotal = notifications.filter((n) => !n.isRead).length;
  const deliveredLabels = useDeliveredTo(open, notifications);

  // Focus moves into the panel when it opens: the first row, else the panel.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const panel = dropdownRef.current;
      const first = panel?.querySelector<HTMLElement>(ROW_SELECTOR);
      (first ?? panel)?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Arrow keys / Home / End walk the rows; Tab still reaches every action.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = Array.from(dropdownRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []);
    if (rows.length === 0) return;
    e.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const last = rows.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key === "ArrowDown"
            ? Math.min(current + 1, last)
            : Math.max(current - 1, 0);
    rows[next]?.focus();
  };

  const headerButton =
    "focus-ring inline-flex items-center rounded-chip px-1.5 text-role-caption transition disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center";

  return (
    <div className="relative flex items-center gap-2" ref={containerRef}>
      {/* Connection indicator */}
      <span
        className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-state-ok-ink" : "bg-ink-dim"}`}
        title={connected ? "Connected" : "Disconnected"}
      />

      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={`focus-ring relative inline-flex items-center justify-center rounded-chip text-ink-mid hover:text-ink transition p-1 pointer-coarse:size-11 ${flash ? "animate-bounce" : ""}`}
        aria-label={
          badgeCount > 0
            ? `${t("notif.title")} · ${t("notifCenter.unread", { count: String(badgeCount) })}`
            : t("notif.title")
        }
        aria-expanded={open}
        aria-haspopup="dialog"
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
        {badgeCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 bg-danger-solid text-danger-solid-ink text-role-caption font-bold rounded-full w-4 h-4 flex items-center justify-center"
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: the dialog container routes arrow keys to its rows
          <div
            ref={dropdownRef}
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            style={
              isMobile
                ? { position: "fixed", top: dropdownPos.top, left: 8, right: 8, zIndex: 9999 }
                : { position: "fixed", top: dropdownPos.top, left: dropdownPos.left, zIndex: 9999 }
            }
            className="rail:w-[min(26.25rem,calc(100vw-2rem))] bg-surface-panel border border-line rounded-card shadow-sheet overflow-hidden flex flex-col max-h-[min(80vh,calc(100vh-6rem))] rail:max-h-[45rem] outline-none"
          >
            <div className="flex items-center gap-2.5 px-4 py-3">
              <h2 id={titleId} className="text-role-body font-semibold text-ink">
                {t("notif.title")}
              </h2>
              {unreadTotal > 0 && (
                <span className="text-role-caption text-ink-muted">
                  {t("notifCenter.unread", { count: String(unreadTotal) })}
                </span>
              )}
              <span className="ml-auto" />
              {budget && (
                <span className="rounded-chip border border-line px-2 py-0.5 text-role-caption text-ink-muted">
                  {t("notifCenter.budget", {
                    used: String(budget.used),
                    limit: String(budget.limit),
                  })}
                </span>
              )}
              {unreadTotal > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={actionLoading}
                  className={`${headerButton} text-accent-deep hover:underline`}
                >
                  {t("notifCenter.markAllRead")}
                </button>
              )}
              {notifications.length > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-label={t("notifCenter.more")}
                    aria-expanded={menuOpen}
                    aria-controls={menuOpen ? menuId : undefined}
                    className={`${headerButton} h-6.5 text-ink-soft hover:bg-surface-hover`}
                  >
                    <MoreGlyph />
                  </button>
                  {menuOpen && (
                    <div
                      id={menuId}
                      className="absolute right-0 top-full z-20 mt-1 min-w-32 rounded-control border border-line bg-surface-panel p-1 shadow-menu"
                    >
                      <button
                        type="button"
                        onClick={clearAll}
                        disabled={actionLoading}
                        className="focus-ring flex w-full min-h-9 items-center rounded-chip px-2.5 text-left text-role-meta text-state-danger-ink hover:bg-surface-hover pointer-coarse:min-h-11"
                      >
                        {t("common.clear")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {approveProGated && <ProFeatureNotice className="m-3" />}
              {notifications.length === 0 ? (
                <p className="border-t border-line py-8 text-center text-role-body text-ink-dim">
                  {t("notif.empty")}
                </p>
              ) : (
                groups.map((group) => {
                  const label = t(`notifCenter.group.${group.key}`);
                  return (
                    <section key={group.key} aria-labelledby={`${titleId}-${group.key}`}>
                      <h3
                        id={`${titleId}-${group.key}`}
                        className="px-4 pt-3 pb-1.5 text-role-caption font-semibold uppercase tracking-[0.06em] text-ink-muted"
                      >
                        {label} · {group.items.length}
                      </h3>
                      <ul>
                        {group.items.map((n) => (
                          <NotificationRow
                            key={n.id}
                            n={n}
                            busy={rowBusy[n.id] ?? null}
                            deliveredLabel={deliveredLabels[n.id]}
                            onOpen={handleNotificationClick}
                            onReply={handleReply}
                            onLater={(x) => void handleLater(x)}
                            onJoin={handleJoin}
                            onApprove={(x) => void handleApprovePendingAction(x)}
                            onReject={handleRejectPendingAction}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })
              )}
            </div>
            <AlertStrip onNavigate={() => closePanel(false)} />
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
