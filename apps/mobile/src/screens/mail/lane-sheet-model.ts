/**
 * The lane sheet's decisions, pure. A lane is a classification, never an
 * action: moving mail changes where Klorn files it (and teaches Klorn), it
 * never touches the mailbox. Exactly the five live lanes — never a sixth,
 * never the retired v1 values.
 */
import type { LiveTier } from "@klorn/contract";
import { LIVE_LANES } from "../../router/routes";

export const SHEET_LANES: readonly LiveTier[] = LIVE_LANES;

/** Where the sheet was opened from. */
export type LaneSheetOrigin = "swipe" | "menu";

/**
 * The lane selected when the sheet opens. A left swipe means "get this out
 * of my way", so SILENT is preselected (canvas notes.gestures) — unless the
 * mail already is SILENT, when the default QUEUE is the useful move. From a
 * menu or the reader the sheet opens on the current lane.
 */
export function initialLane(origin: LaneSheetOrigin, current: LiveTier | null): LiveTier {
  if (origin === "swipe") return current === "SILENT" ? "QUEUE" : "SILENT";
  return current ?? "QUEUE";
}

export interface LaneSheetState {
  selected: LiveTier;
  /** "Keep this sender here" — pin the sender to the selected lane. */
  pin: boolean;
}

/**
 * Whether the primary button does anything: a different lane, or the same
 * lane with "keep this sender here" newly asked for.
 */
export function canSubmit(state: LaneSheetState, current: LiveTier | null): boolean {
  return state.selected !== current || state.pin;
}

export type LaneSubmitPlan = {
  /** POST /api/inbox/firewall/email/:emailId {tier} (reversible) — when the lane changes. */
  move: boolean;
  /** POST /api/email/:id/pin-tier {tier} — when the toggle is on. */
  pin: boolean;
  tier: LiveTier;
};

export function submitPlan(state: LaneSheetState, current: LiveTier | null): LaneSubmitPlan {
  return { move: state.selected !== current, pin: state.pin, tier: state.selected };
}

/**
 * "Turns on by itself when you move the same sender twice" (lane.pin.hint).
 * The toggle starts OFF — a pin is a standing rule for every future mail, so
 * it is never set silently — except when this device already moved the same
 * sender to the same lane within the window: the second move then opens with
 * the toggle on, and the user can still turn it off. Senders are kept as
 * hashes (lane-history.ts), never as addresses.
 */
export interface LaneMove {
  sender: string;
  lane: LiveTier;
  at: number;
}

export const PIN_SUGGEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const LANE_HISTORY_MAX = 200;

/** History after moving `senders` to `lane` at `now`: newest first, one entry per sender, capped. */
export function rememberMoves(
  history: readonly LaneMove[],
  senders: readonly string[],
  lane: LiveTier,
  now: number,
): LaneMove[] {
  const fresh = [...new Set(senders)].map((sender) => ({ sender, lane, at: now }));
  const moved = new Set(fresh.map((m) => m.sender));
  const kept = history.filter((m) => !moved.has(m.sender) && now - m.at <= PIN_SUGGEST_WINDOW_MS);
  return [...fresh, ...kept].slice(0, LANE_HISTORY_MAX);
}

/** Whether the toggle should start on: this sender was already moved to this lane recently. */
export function suggestsPin(
  history: readonly LaneMove[],
  sender: string | null,
  lane: LiveTier,
  now: number,
): boolean {
  if (!sender) return false;
  const last = history.find((m) => m.sender === sender);
  return !!last && last.lane === lane && now - last.at <= PIN_SUGGEST_WINDOW_MS;
}

/** "박서연 <seoyeon@x>" → "박서연"; a bare address stays itself. */
export function senderLabel(from: string): string {
  const trimmed = from.trim();
  const lt = trimmed.indexOf("<");
  if (lt > 0) {
    const name = trimmed
      .slice(0, lt)
      .trim()
      .replace(/^["']+|["']+$/g, "")
      .trim();
    if (name) return name;
  }
  return trimmed.replace(/^<|>$/g, "");
}
