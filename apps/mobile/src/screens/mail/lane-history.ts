/**
 * This device's recent lane moves, for the "second move turns the pin on"
 * rule (lane-sheet-model.ts suggestsPin). Senders are stored as SHA-256 hashes
 * of their lower-cased address — nothing readable in Preferences or a backup —
 * and entries older than the window drop out. Cleared on sign-out
 * (auth/session.tsx). Best-effort throughout: a failure only means the toggle
 * starts off, as it would anyway.
 */
import type { LiveTier } from "@klorn/contract";
import { kv } from "../../platform/kv";
import { LIVE_LANES } from "../../router/routes";
import { type LaneMove, rememberMoves } from "./lane-sheet-model";
import { addressOf } from "./model";

const KEY = "klorn-lane-moves-v1";

/** The hashed sender key of a From header, or null without WebCrypto / an address. */
export async function senderKey(from: string): Promise<string | null> {
  const address = addressOf(from).toLowerCase();
  const subtle = globalThis.crypto?.subtle;
  if (!address || !subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(address));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function isMove(value: unknown): value is LaneMove {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.sender === "string" &&
    /^[0-9a-f]{32}$/.test(m.sender) &&
    typeof m.at === "number" &&
    Number.isFinite(m.at) &&
    (LIVE_LANES as readonly unknown[]).includes(m.lane)
  );
}

export async function loadLaneMoves(): Promise<LaneMove[]> {
  try {
    const parsed: unknown = JSON.parse((await kv.getItem(KEY)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isMove) : [];
  } catch {
    return [];
  }
}

/** After a successful move: remember each sender's new lane. */
export async function recordLaneMoves(froms: readonly string[], lane: LiveTier): Promise<void> {
  try {
    const keys = (await Promise.all(froms.map(senderKey))).filter((k): k is string => k !== null);
    if (keys.length === 0) return;
    const next = rememberMoves(await loadLaneMoves(), keys, lane, Date.now());
    await kv.setItem(KEY, JSON.stringify(next));
  } catch {
    // A convenience only.
  }
}

export async function clearLaneMoves(): Promise<void> {
  await kv.removeItem(KEY).catch(() => {});
}
