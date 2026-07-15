/**
 * Wire contract for the daily briefing status — `GET /api/briefing/status`.
 * Built by packages/api/src/pim/briefing-status.ts; rendered by the web
 * briefing page and the Command Center briefing card. Both sides import
 * these types, so a shape change that would desync server and client fails
 * to compile instead of failing in production.
 */

export type BriefingPushState =
  | "received"
  | "accepted"
  | "failed"
  | "skipped"
  | "pending"
  | "not_sent"
  | "no_subscription";

export interface BriefingStatus {
  date: string;
  generated: boolean;
  note: {
    id: string;
    content: string;
    preview: string;
    createdAt: string;
  } | null;
  notification: {
    id: string;
    title: string;
    message: string;
    createdAt: string;
  } | null;
  push: {
    state: BriefingPushState;
    reason: string | null;
    deliveryId: string | null;
    acceptedAt: string | null;
    receivedAt: string | null;
    clickedAt: string | null;
  };
  automation: {
    configured: boolean;
    enabled: boolean;
    briefingTime: string | null;
    timezone: string;
    reason: "no_config" | "disabled" | null;
  };
}
