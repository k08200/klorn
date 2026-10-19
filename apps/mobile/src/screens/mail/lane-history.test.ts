import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, string>());
vi.mock("../../platform/kv", () => ({
  kv: {
    getItem: async (k: string) => prefs.get(k) ?? null,
    setItem: async (k: string, v: string) => void prefs.set(k, v),
    removeItem: async (k: string) => void prefs.delete(k),
  },
}));

const { clearLaneMoves, loadLaneMoves, recordLaneMoves, senderKey } = await import(
  "./lane-history"
);
const { LANE_HISTORY_MAX, PIN_SUGGEST_WINDOW_MS, rememberMoves, suggestsPin } = await import(
  "./lane-sheet-model"
);

const NOW = 1_800_000_000_000;

beforeEach(() => prefs.clear());

describe("second move turns the pin on", () => {
  it("starts off for a sender never moved, on for the same lane again, off for another lane", () => {
    const history = rememberMoves([], ["s1"], "SILENT", NOW);
    expect(suggestsPin([], "s1", "SILENT", NOW)).toBe(false);
    expect(suggestsPin(history, "s1", "SILENT", NOW + 1000)).toBe(true);
    expect(suggestsPin(history, "s1", "INFO", NOW + 1000)).toBe(false);
    expect(suggestsPin(history, "s2", "SILENT", NOW + 1000)).toBe(false);
    expect(suggestsPin(history, null, "SILENT", NOW + 1000)).toBe(false);
  });

  it("forgets moves older than the window", () => {
    const history = rememberMoves([], ["s1"], "SILENT", NOW);
    expect(suggestsPin(history, "s1", "SILENT", NOW + PIN_SUGGEST_WINDOW_MS + 1)).toBe(false);
    const later = rememberMoves(history, ["s2"], "QUEUE", NOW + PIN_SUGGEST_WINDOW_MS + 1);
    expect(later.map((m) => m.sender)).toEqual(["s2"]);
  });

  it("keeps one entry per sender (the newest lane), newest first, capped", () => {
    let history = rememberMoves([], ["s1"], "SILENT", NOW);
    history = rememberMoves(history, ["s1", "s1"], "INFO", NOW + 1);
    expect(history).toEqual([{ sender: "s1", lane: "INFO", at: NOW + 1 }]);
    const many = Array.from({ length: LANE_HISTORY_MAX + 5 }, (_, i) => `x${i}`);
    expect(rememberMoves(history, many, "QUEUE", NOW + 2)).toHaveLength(LANE_HISTORY_MAX);
  });
});

describe("lane history store", () => {
  it("stores hashed senders only, keyed on the address, case-insensitive", async () => {
    await recordLaneMoves(["박서연 <Seoyeon@Example.com>"], "SILENT");
    const raw = prefs.get("klorn-lane-moves-v1") ?? "";
    expect(raw).not.toContain("seoyeon");
    expect(raw).not.toContain("박서연");
    const key = await senderKey("seoyeon@example.com");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const history = await loadLaneMoves();
    expect(history[0]?.sender).toBe(key);
    expect(suggestsPin(history, key, "SILENT", Date.now())).toBe(true);
  });

  it("ignores malformed stored data and clears on sign-out", async () => {
    prefs.set(
      "klorn-lane-moves-v1",
      JSON.stringify([
        { sender: "nope", lane: "SILENT", at: 1 },
        { sender: "a".repeat(32), lane: "AUTO", at: 1 },
      ]),
    );
    expect(await loadLaneMoves()).toEqual([]);
    prefs.set("klorn-lane-moves-v1", "{not json");
    expect(await loadLaneMoves()).toEqual([]);
    await recordLaneMoves(["a@b.c"], "QUEUE");
    await clearLaneMoves();
    expect(prefs.has("klorn-lane-moves-v1")).toBe(false);
  });
});
