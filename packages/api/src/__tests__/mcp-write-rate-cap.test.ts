/**
 * MCP write rate cap — per USER (never per key: five keys must not multiply
 * the budget), sliding window, in-process (so per instance, like the
 * team_availability precedent in tool-executor.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeMcpWriteBudget,
  MCP_WRITE_CAP_PER_WINDOW,
  MCP_WRITE_WINDOW_MS,
} from "../mcp/write-rate-cap.js";

let userSeq = 0;
/** A fresh user per test: the window lives in module state by design. */
const freshUser = () => `rate-cap-user-${++userSeq}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("consumeMcpWriteBudget", () => {
  it("proposes 30 writes per minute", () => {
    expect(MCP_WRITE_CAP_PER_WINDOW).toBe(30);
    expect(MCP_WRITE_WINDOW_MS).toBe(60_000);
  });

  it("allows exactly the cap, then refuses", () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) {
      expect(consumeMcpWriteBudget(userId), `call ${i + 1}`).toBe(true);
    }
    expect(consumeMcpWriteBudget(userId)).toBe(false);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
  });

  it("a refused call does not extend the window (refusals are not recorded)", () => {
    const userId = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) consumeMcpWriteBudget(userId);
    vi.advanceTimersByTime(MCP_WRITE_WINDOW_MS - 1);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(consumeMcpWriteBudget(userId)).toBe(true);
  });

  it("slides: only calls older than the window free up budget", () => {
    const userId = freshUser();
    for (let i = 0; i < 10; i++) consumeMcpWriteBudget(userId);
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW - 10; i++) consumeMcpWriteBudget(userId);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
    // The first 10 age out; the later 20 still count.
    vi.advanceTimersByTime(MCP_WRITE_WINDOW_MS - 30_000);
    for (let i = 0; i < 10; i++) expect(consumeMcpWriteBudget(userId)).toBe(true);
    expect(consumeMcpWriteBudget(userId)).toBe(false);
  });

  it("keeps users independent", () => {
    const a = freshUser();
    const b = freshUser();
    for (let i = 0; i < MCP_WRITE_CAP_PER_WINDOW; i++) consumeMcpWriteBudget(a);
    expect(consumeMcpWriteBudget(a)).toBe(false);
    expect(consumeMcpWriteBudget(b)).toBe(true);
  });
});
