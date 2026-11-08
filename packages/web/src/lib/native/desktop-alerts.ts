// OS banners for the Windows desktop shell (apps/desktop-win, Tauri v2).
//
// Parity with the Mac app (founder decision, 2026-10-15): PUSH-lane mail and
// meetings starting soon arrive as OS notification banners; nothing else
// does. WebView2 has no dependable Web Push, so inside the shell the banner is
// driven by the real-time `notification` frame the bell already receives.
//
// This module does NOT classify. The server tags a frame with
// `alert: "push" | "meeting"` only for PUSH mail / a meeting starting soon, and
// only when the user's notification preferences and quiet hours allow it
// (packages/api notify/desktop-alert.ts — the same gate Web Push uses). Here we
// validate that tag, shape the banner text, and dedupe by notification id.
//
// Pure functions over plain inputs, so the rules are unit-tested without a
// browser (packages/api/src/__tests__/web-desktop-alerts.test.ts).

import type { DesktopAlertKind } from "@klorn/contract";

export type { DesktopAlertKind };

export interface DesktopAlert {
  id: string;
  kind: DesktopAlertKind;
  title: string;
  body: string;
}

/** Longest title / body handed to the OS toast. Windows truncates long toast
 *  text anyway; capping here bounds what an attacker-chosen subject can push
 *  through the IPC bridge. */
export const TITLE_MAX = 120;
export const BODY_MAX = 240;
/** Notification ids remembered (per account, across restarts — see
 *  ./desktop-catchup.ts). Far above the bell's 30-row window and any realistic
 *  number of PUSH/meeting interrupts a day; trimming only drops the oldest. */
export const SEEN_CAP = 500;
const ID_MAX = 200;
const FALLBACK_TITLE = "Klorn";

const KINDS: readonly DesktopAlertKind[] = ["push", "meeting"];

function isKind(value: unknown): value is DesktopAlertKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Longest message read before shaping, so the marker strip below never
 *  scans an unbounded string. */
export const MESSAGE_SCAN_MAX = 1000;

/** Meeting frames end in a ` [eventId]` dedupe marker (background.ts). It is
 *  bookkeeping, not copy. PUSH frames carry none, so a subject that really
 *  ends in "[URGENT]" is left alone. (Stored PUSH bell rows DO end in a
 *  `[gmailId,…]` marker — desktop-catchup.ts strips it with this too.) */
export function stripTrailingMarker(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("]")) return trimmed;
  const open = trimmed.lastIndexOf("[");
  return open === -1 ? trimmed : trimmed.slice(0, open).trimEnd();
}

/** The banner for one real-time frame, or null when it is not an interrupt
 *  the server tagged for an OS banner. Never throws on malformed input. */
export function parseDesktopAlert(payload: unknown): DesktopAlert | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const frame = payload as Record<string, unknown>;
  if (!isKind(frame.alert)) return null;
  const { id, title, message } = frame;
  if (typeof id !== "string" || id.length === 0 || id.length > ID_MAX) return null;
  if (title !== undefined && typeof title !== "string") return null;
  const cleanTitle = (title ?? "").trim() || FALLBACK_TITLE;
  const raw = typeof message === "string" ? message.slice(0, MESSAGE_SCAN_MAX) : "";
  const body = frame.alert === "meeting" ? stripTrailingMarker(raw) : raw.trim();
  return {
    id,
    kind: frame.alert,
    title: cleanTitle.slice(0, TITLE_MAX),
    body: body.slice(0, BODY_MAX),
  };
}

export interface DesktopAlertPlan {
  alert: DesktopAlert | null;
  seen: string[];
}

/** Decide whether this frame banners, given the ids already bannered (the
 *  persisted ledger, ./desktop-catchup.ts). Returns a new seen list; the input
 *  is never mutated. */
export function planDesktopAlert(seen: readonly string[], payload: unknown): DesktopAlertPlan {
  const alert = parseDesktopAlert(payload);
  if (!alert || seen.includes(alert.id)) return { alert: null, seen: [...seen] };
  return { alert, seen: [...seen, alert.id].slice(-SEEN_CAP) };
}
