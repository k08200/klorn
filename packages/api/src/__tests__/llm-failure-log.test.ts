/**
 * Failed LLM provider calls must be visible (#1319). LlmUsageLog only records
 * SUCCESSFUL calls, so the 2026-09-05 OpenRouter credit outage left no trace:
 * every judge call failed for four weeks and nothing said why. This module is
 * the failure-side record — a structured, rate-limited, content-free log line
 * plus a bounded per-provider tally the judge-health alarm reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLlmFailureLog,
  classifyLlmFailure,
  getLlmFailureCounts,
  getTopLlmFailure,
  LLM_FAILURE_LOG_INTERVAL_MS,
  LLM_FAILURE_MAX_EVENTS,
  LLM_FAILURE_WINDOW_MS,
  recordLlmCallFailure,
} from "../llm/llm-failure-log.js";

const T0 = 1_800_000_000_000;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function failureLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.startsWith("[LLM-FAILURE] "))
    .map((line) => JSON.parse(line.slice("[LLM-FAILURE] ".length)) as Record<string, unknown>);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetLlmFailureLog();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyLlmFailure", () => {
  it("names a 402 as credits exhausted with its status and error class", () => {
    const cls = classifyLlmFailure(httpError(402, "402 Insufficient credits"));
    expect(cls).toMatchObject({ status: 402, code: "credits_exhausted" });
    expect(cls.label).toBe("402 credits exhausted");
    expect(cls.errorClass).toBe("Error 402");
  });

  it("separates auth, rate-limit, upstream and connection failures", () => {
    expect(classifyLlmFailure(httpError(401, "401 User not found")).code).toBe("auth_rejected");
    expect(classifyLlmFailure(httpError(429, "429 Too many requests")).code).toBe("rate_limited");
    expect(classifyLlmFailure(httpError(503, "503 upstream")).code).toBe("upstream_error");
    expect(classifyLlmFailure(new Error("fetch failed")).code).toBe("connection");
    expect(classifyLlmFailure(httpError(400, "400 bad")).code).toBe("bad_request");
  });

  it("tolerates non-Error throwables", () => {
    expect(classifyLlmFailure(null).code).toBe("other");
    expect(classifyLlmFailure("boom").errorClass).toBe("UnknownError");
  });
});

describe("recordLlmCallFailure — structured log line", () => {
  it("logs provider, model, error class, HTTP status and code", () => {
    recordLlmCallFailure(
      { provider: "openrouter", model: "google/gemma-4-31b-it" },
      httpError(402, "402 Insufficient credits"),
      T0,
    );
    const lines = failureLines(warnSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      provider: "openrouter",
      model: "google/gemma-4-31b-it",
      errorClass: "Error 402",
      status: 402,
      code: "credits_exhausted",
    });
  });

  it("never logs the provider message (it can quote the rejected key) or any prompt", () => {
    recordLlmCallFailure(
      { provider: "openrouter", model: "m" },
      httpError(401, "401 invalid key sk-or-v1-SECRETSECRET for prompt: Dear Bob"),
      T0,
    );
    const raw = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("Dear Bob");
    expect(raw).not.toContain("invalid key");
  });

  it("rate-limits identical failure classes to one line per interval, then reports the suppressed count", () => {
    for (let i = 0; i < 50; i++) {
      recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(402, "402"), T0 + i);
    }
    expect(failureLines(warnSpy)).toHaveLength(1);

    recordLlmCallFailure(
      { provider: "openrouter", model: "m" },
      httpError(402, "402"),
      T0 + LLM_FAILURE_LOG_INTERVAL_MS + 1,
    );
    const lines = failureLines(warnSpy);
    expect(lines).toHaveLength(2);
    expect(lines[1].suppressedSinceLast).toBe(49);
  });

  it("logs each distinct failure class on its own", () => {
    recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(402, "402"), T0);
    recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(429, "429"), T0);
    recordLlmCallFailure({ provider: "gemini", model: "g" }, httpError(402, "402"), T0);
    expect(failureLines(warnSpy)).toHaveLength(3);
  });

  it("never throws, whatever was thrown at the provider", () => {
    expect(() =>
      recordLlmCallFailure({ provider: "openrouter", model: "m" }, undefined, T0),
    ).not.toThrow();
  });
});

describe("failure tally — per provider, per window, bounded", () => {
  it("counts failures per provider, keeping BYOK keys apart from the env key", () => {
    recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(402, "402"), T0);
    recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(402, "402"), T0);
    recordLlmCallFailure(
      { provider: "openrouter", model: "m", ownedByUser: true },
      httpError(401, "401"),
      T0,
    );
    const counts = getLlmFailureCounts(T0);
    const env = counts.find((c) => c.provider === "openrouter");
    const user = counts.find((c) => c.provider === "openrouter:user");
    expect(env).toMatchObject({ total: 2, byLabel: { "402 credits exhausted": 2 } });
    expect(user).toMatchObject({ total: 1, byLabel: { "401 auth rejected": 1 } });
  });

  it("drops failures older than the window", () => {
    recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(402, "402"), T0);
    expect(getLlmFailureCounts(T0 + LLM_FAILURE_WINDOW_MS + 1)).toEqual([]);
    expect(getTopLlmFailure(T0 + LLM_FAILURE_WINDOW_MS + 1)).toBeNull();
  });

  it("bounds memory during a sustained outage", () => {
    for (let i = 0; i < LLM_FAILURE_MAX_EVENTS + 500; i++) {
      recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(402, "402"), T0);
    }
    const total = getLlmFailureCounts(T0).reduce((n, c) => n + c.total, 0);
    expect(total).toBe(LLM_FAILURE_MAX_EVENTS);
  });

  it("names the most frequent failure class and its provider", () => {
    recordLlmCallFailure({ provider: "gemini", model: "g" }, httpError(429, "429"), T0);
    for (let i = 0; i < 3; i++) {
      recordLlmCallFailure({ provider: "openrouter", model: "m" }, httpError(402, "402"), T0);
    }
    expect(getTopLlmFailure(T0)).toEqual({
      provider: "openrouter",
      label: "402 credits exhausted",
      count: 3,
    });
  });
});
