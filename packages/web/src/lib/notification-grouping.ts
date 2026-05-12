export interface GroupableNotification {
  id: string;
  type: string;
  title: string;
  isRead: boolean;
  createdAt: string;
  pendingActionId?: string | null;
}

export interface NotificationGroup<T extends GroupableNotification> {
  key: string;
  type: string;
  isAgent: boolean;
  items: T[];
  latestItem: T;
  unreadCount: number;
}

const TYPE_LABELS_KO: Record<string, string> = {
  reminder: "알림",
  calendar: "일정",
  email: "메일",
  task: "할 일",
  meeting: "미팅",
  briefing: "브리핑",
  agent_proposal: "Jigeum 제안",
  insight: "인사이트",
};

const AGENT_PREFIX = "[Eve]";
const LEGACY_AGENT_PREFIX = "[EV" + "E]";

export function isAgentNotification(title: string): boolean {
  return title.startsWith(AGENT_PREFIX) || title.startsWith(LEGACY_AGENT_PREFIX);
}

export function getTypeLabel(type: string): string {
  return TYPE_LABELS_KO[type] ?? type;
}

function isStandalone(n: GroupableNotification): boolean {
  if (n.pendingActionId) return true;
  if (n.type === "agent_proposal") return true;
  return false;
}

function groupKeyFor(n: GroupableNotification): string {
  return `${isAgentNotification(n.title) ? "agent_" : ""}${n.type}`;
}

/**
 * Group notifications by `type + agent-prefix flag` while keeping standalone items
 * (pending-action-bound and `agent_proposal`) ungrouped.
 *
 * Order is preserved: the first standalone or first member of each group dictates
 * placement so the caller's incoming sort (typically newest-first) is respected.
 */
export function groupNotifications<T extends GroupableNotification>(
  notifications: T[],
): NotificationGroup<T>[] {
  const groups = new Map<string, NotificationGroup<T>>();
  const order: string[] = [];

  for (const n of notifications) {
    if (isStandalone(n)) {
      const key = `__standalone_${n.id}`;
      groups.set(key, {
        key,
        type: n.type,
        isAgent: isAgentNotification(n.title),
        items: [n],
        latestItem: n,
        unreadCount: n.isRead ? 0 : 1,
      });
      order.push(key);
      continue;
    }

    const key = groupKeyFor(n);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(n);
      if (!n.isRead) existing.unreadCount += 1;
      if (new Date(n.createdAt).getTime() > new Date(existing.latestItem.createdAt).getTime()) {
        existing.latestItem = n;
      }
    } else {
      groups.set(key, {
        key,
        type: n.type,
        isAgent: isAgentNotification(n.title),
        items: [n],
        latestItem: n,
        unreadCount: n.isRead ? 0 : 1,
      });
      order.push(key);
    }
  }

  return order.map((k) => groups.get(k)!);
}

export function unreadGroupCount<T extends GroupableNotification>(
  groups: NotificationGroup<T>[],
): number {
  return groups.reduce((acc, g) => (g.unreadCount > 0 ? acc + 1 : acc), 0);
}
