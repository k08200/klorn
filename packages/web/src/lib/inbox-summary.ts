/**
 * Type contract for the inbox Command Center summary returned by
 * `GET /api/inbox/summary`. The server owns the ranking — the frontend just
 * renders. Keep this file in sync with `packages/api/src/pim/inbox-summary.ts`.
 */

export type AttentionItem =
  | {
      kind: "pending_action";
      id: string;
      toolName: string;
      label: string;
      conversationId: string;
      reasoning: string | null;
      decision: DecisionDetails;
    }
  | {
      kind: "overdue_task";
      id: string;
      title: string;
      dueDate: string;
      daysOverdue: number;
      decision: DecisionDetails;
    }
  | {
      kind: "today_event";
      id: string;
      title: string;
      startTime: string;
      minutesAway: number;
      location: string | null;
      decision: DecisionDetails;
    }
  | {
      kind: "agent_proposal";
      id: string;
      title: string;
      message: string;
      link: string | null;
      decision: DecisionDetails;
    }
  | {
      kind: "commitment";
      id: string;
      title: string;
      description: string | null;
      commitmentKind: string;
      owner: string;
      dueAt: string | null;
      dueText: string | null;
      confidence: number;
      attentionType: "COMMITMENT_DUE" | "COMMITMENT_OVERDUE" | "COMMITMENT_UNCONFIRMED";
      decision: DecisionDetails;
    };

export interface DecisionEvidenceFact {
  label: string;
  value: string;
}

export interface DecisionDetails {
  priority: number;
  confidence: number;
  suggestedAction: string | null;
  costOfIgnoring: string | null;
  evidence: DecisionEvidenceFact[];
}

export interface TaskItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

export interface EventItem {
  id: string;
  title: string;
  startTime: string;
  endTime?: string;
  location?: string | null;
}

export interface TodaySection {
  events: EventItem[];
  overdueTasks: TaskItem[];
  todayTasks: TaskItem[];
}

export interface InboxSummary {
  top3: AttentionItem[];
  today: TodaySection;
}

export interface ReplyNeededEmail {
  id: string;
  subject: string;
  from: string;
  snippet: string | null;
  needsReplyReason: string | null;
  needsReplyConfidence: number;
  receivedAt: string;
}
