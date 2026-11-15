import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { fetchHealth, parseHealth, pollHealth } from "../lib/health.js";

const BODY = {
  status: "ok",
  db: "connected",
  timestamp: "2026-11-15T08:30:00.000Z",
  uptime: 12,
  version: "0.4.0",
  commit: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("parseHealth", () => {
  it("accepts the /api/health body", () => {
    expect(parseHealth(BODY)).toEqual(BODY);
  });

  it("rejects anything else", () => {
    expect(parseHealth({ status: "ok" })).toBeNull();
    expect(parseHealth("ok")).toBeNull();
  });
});

describe("fetchHealth", () => {
  it("fetches <api>/api/health", async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string | URL | Request) => {
      urls.push(String(url));
      return json(BODY);
    };
    const result = await fetchHealth(fetchFn as typeof fetch, "http://localhost:3001/");
    expect(result.health.version).toBe("0.4.0");
    expect(urls).toEqual(["http://localhost:3001/api/health"]);
  });

  it("reports an unreachable API as a CliError", async () => {
    const fetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(fetchHealth(fetchFn as typeof fetch, "http://localhost:3001")).rejects.toThrow(
      CliError,
    );
  });

  it("rejects a non-JSON or non-health answer", async () => {
    const fetchFn = async () => new Response("<html>", { status: 200 });
    await expect(fetchHealth(fetchFn as typeof fetch, "http://x")).rejects.toThrow(/not a Klorn/);
  });
});

describe("pollHealth", () => {
  it("polls until the answer is accepted", async () => {
    const answers = [
      () => {
        throw new TypeError("ECONNREFUSED");
      },
      () => json({ ...BODY, version: "0.4.0" }),
      () => json({ ...BODY, version: "0.4.1" }),
    ];
    let i = 0;
    let clock = 0;
    const health = await pollHealth(
      {
        fetch: (async () => (answers[i++] ?? answers[2])?.()) as unknown as typeof fetch,
        nowMs: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
      "http://x",
      (h) => h.version === "0.4.1",
      { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    expect(health.version).toBe("0.4.1");
    expect(i).toBe(3);
  });

  it("gives up after the timeout and says what it last saw", async () => {
    let clock = 0;
    const err = await pollHealth(
      {
        fetch: (async () =>
          json({ ...BODY, status: "degraded", db: "unreachable" })) as typeof fetch,
        nowMs: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
      "http://x",
      (h) => h.status === "ok",
      { timeoutMs: 10_000, intervalMs: 2_000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(String(err)).toMatch(/degraded/);
  });
});
