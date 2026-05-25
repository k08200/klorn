/**
 * Centralized TanStack Query keys.
 *
 * Every cache key the EVE web client uses lives here so:
 *   1. invalidation can be triggered from anywhere without typos
 *      (e.g. after a mutation, call `queryClient.invalidateQueries({
 *      queryKey: queryKeys.tasks.list() })`).
 *   2. searching for "what reads this endpoint" is a single grep.
 *
 * Pattern: namespace → list / item / sub-resource. Always a tuple so
 * tanstack-query can match prefixes (`["tasks"]` invalidates every
 * `["tasks", ...]` key).
 */

export const queryKeys = {
  tasks: {
    all: ["tasks"] as const,
    list: () => ["tasks", "list"] as const,
    detail: (id: string) => ["tasks", "detail", id] as const,
  },
  notes: {
    all: ["notes"] as const,
    list: (filters?: { search?: string; category?: string }) =>
      ["notes", "list", filters ?? {}] as const,
  },
  contacts: {
    all: ["contacts"] as const,
    list: () => ["contacts", "list"] as const,
    detail: (id: string) => ["contacts", "detail", id] as const,
  },
  briefing: {
    all: ["briefing"] as const,
    today: () => ["briefing", "today"] as const,
    feedback: (noteId: string) => ["briefing", "feedback", noteId] as const,
    status: () => ["briefing", "status"] as const,
    todayActions: () => ["briefing", "today-actions"] as const,
  },
  inbox: {
    all: ["inbox"] as const,
    summary: () => ["inbox", "summary"] as const,
    commitments: () => ["inbox", "commitments"] as const,
    pending: () => ["inbox", "pending"] as const,
    receipt: (date?: string) => ["inbox", "receipt", date ?? "today"] as const,
  },
  email: {
    all: ["email"] as const,
    list: (params?: { filter?: string; search?: string; category?: string; page?: number }) =>
      ["email", "list", params ?? {}] as const,
    detail: (id: string) => ["email", "detail", id] as const,
    candidates: (filters?: { status?: string; attention?: string }) =>
      ["email", "candidates", filters ?? {}] as const,
    rules: () => ["email", "rules"] as const,
  },
  commitments: {
    all: ["commitments"] as const,
    list: (status?: string) => ["commitments", "list", status ?? "all"] as const,
  },
  calendar: {
    all: ["calendar"] as const,
    events: (range?: { from: string; to: string }) => ["calendar", "events", range ?? {}] as const,
  },
  reminders: {
    all: ["reminders"] as const,
    list: () => ["reminders", "list"] as const,
  },
  workGraph: {
    all: ["work-graph"] as const,
    summary: () => ["work-graph", "summary"] as const,
  },
  settings: {
    all: ["settings"] as const,
    profile: () => ["settings", "profile"] as const,
    automation: () => ["settings", "automation"] as const,
    voice: () => ["settings", "voice"] as const,
    usage: (range?: string) => ["settings", "usage", range ?? "default"] as const,
    skills: () => ["settings", "skills"] as const,
    memory: () => ["settings", "memory"] as const,
    status: () => ["settings", "status"] as const,
  },
  chat: {
    all: ["chat"] as const,
    conversations: () => ["chat", "conversations"] as const,
    messages: (conversationId: string) => ["chat", "messages", conversationId] as const,
  },
  notifications: {
    all: ["notifications"] as const,
    list: () => ["notifications", "list"] as const,
    count: () => ["notifications", "count"] as const,
  },
  playbooks: {
    all: ["playbooks"] as const,
    list: () => ["playbooks", "list"] as const,
    recommendations: (params?: { limit?: number; contextLimit?: number }) =>
      ["playbooks", "recommendations", params ?? {}] as const,
  },
} as const;
