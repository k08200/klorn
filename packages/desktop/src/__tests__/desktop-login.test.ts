import { describe, expect, it, vi } from "vitest";
import { type DesktopLoginDeps, runDesktopGoogleLogin } from "../desktop-login.js";

/** Build a Response-like stub good enough for the orchestration's `.status`/`.json()`. */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A 200 whose body fails to parse — mimics a proxy/CDN returning an HTML page. */
function nonJsonOk(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
  } as unknown as Response;
}

/** Route fetch by URL to a nonce handler and a token handler. */
function makeFetch(handlers: {
  nonce: () => Response | Promise<Response>;
  token: () => Response | Promise<Response>;
}): typeof fetch {
  return ((url: string) => {
    if (url.includes("/api/auth/desktop-nonce")) return Promise.resolve(handlers.nonce());
    if (url.includes("/api/auth/desktop-token/")) return Promise.resolve(handlers.token());
    return Promise.reject(new Error(`unexpected url ${url}`));
  }) as unknown as typeof fetch;
}

function baseDeps(overrides: Partial<DesktopLoginDeps> = {}): DesktopLoginDeps {
  return {
    apiBase: "http://localhost:3001",
    fetchFn: makeFetch({
      nonce: () => res(200, { nonce: "N1" }),
      token: () => res(200, { status: "ok", token: "jwt-123" }),
    }),
    openExternal: () => {},
    sleep: () => Promise.resolve(),
    now: () => 0,
    log: () => {},
    ...overrides,
  };
}

describe("runDesktopGoogleLogin", () => {
  it("returns the token and opens the desktop login URL on the happy path", async () => {
    const opened: string[] = [];
    const result = await runDesktopGoogleLogin(
      baseDeps({ openExternal: (url) => void opened.push(url) }),
    );

    expect(result).toEqual({ ok: true, token: "jwt-123" });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/api/auth/google/login");
    expect(opened[0]).toContain("source=desktop");
    expect(opened[0]).toContain("nonce=N1");
  });

  it("keeps polling through 202 pending until the token lands", async () => {
    const tokenSeq = [
      res(202, { status: "pending" }),
      res(202, { status: "pending" }),
      res(200, { status: "ok", token: "jwt-late" }),
    ];
    let i = 0;
    const sleep = vi.fn(async () => {});
    const result = await runDesktopGoogleLogin(
      baseDeps({
        sleep,
        fetchFn: makeFetch({
          nonce: () => res(200, { nonce: "N1" }),
          token: () => tokenSeq[Math.min(i++, tokenSeq.length - 1)],
        }),
      }),
    );

    expect(result).toEqual({ ok: true, token: "jwt-late" });
    expect(sleep).toHaveBeenCalledTimes(2); // slept twice between the three polls
  });

  it("retries a transient poll network error, then succeeds", async () => {
    let call = 0;
    const result = await runDesktopGoogleLogin(
      baseDeps({
        fetchFn: makeFetch({
          nonce: () => res(200, { nonce: "N1" }),
          token: () => {
            call += 1;
            if (call === 1) throw new Error("ECONNRESET");
            return res(200, { status: "ok", token: "jwt-after-blip" });
          },
        }),
      }),
    );

    expect(result).toEqual({ ok: true, token: "jwt-after-blip" });
  });

  it("retries a non-JSON 200 body (proxy error page), then succeeds", async () => {
    let call = 0;
    const result = await runDesktopGoogleLogin(
      baseDeps({
        fetchFn: makeFetch({
          nonce: () => res(200, { nonce: "N1" }),
          token: () => {
            call += 1;
            return call === 1 ? nonJsonOk() : res(200, { status: "ok", token: "jwt-recovered" });
          },
        }),
      }),
    );

    expect(result).toEqual({ ok: true, token: "jwt-recovered" });
  });

  it("does not open the browser when the nonce request fails", async () => {
    const opened: string[] = [];
    const result = await runDesktopGoogleLogin(
      baseDeps({
        openExternal: (url) => void opened.push(url),
        fetchFn: makeFetch({ nonce: () => res(500, {}), token: () => res(200, {}) }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "nonce_failed",
      detail: "desktop-nonce returned 500",
    });
    expect(opened).toHaveLength(0);
  });

  it("treats a nonce response without a nonce as a start failure", async () => {
    const result = await runDesktopGoogleLogin(
      baseDeps({
        fetchFn: makeFetch({ nonce: () => res(200, { wrong: true }), token: () => res(200, {}) }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nonce_failed");
  });

  it("reports invalid_nonce on a 404 from the poll", async () => {
    const result = await runDesktopGoogleLogin(
      baseDeps({
        fetchFn: makeFetch({
          nonce: () => res(200, { nonce: "N1" }),
          token: () => res(404, { error: "Not found" }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid_nonce" });
  });

  it("reports expired on a 410 from the poll", async () => {
    const result = await runDesktopGoogleLogin(
      baseDeps({
        fetchFn: makeFetch({
          nonce: () => res(200, { nonce: "N1" }),
          token: () => res(410, { error: "Expired" }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("times out when the browser never completes", async () => {
    let t = 0;
    const result = await runDesktopGoogleLogin(
      baseDeps({
        now: () => t,
        sleep: () => {
          t += 30_000; // advance the clock each sleep so the deadline is reached fast
          return Promise.resolve();
        },
        fetchFn: makeFetch({
          nonce: () => res(200, { nonce: "N1" }),
          token: () => res(202, { status: "pending" }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("stops with cancelled when the cancel check trips", async () => {
    const result = await runDesktopGoogleLogin(
      baseDeps({
        isCancelled: () => true,
        fetchFn: makeFetch({
          nonce: () => res(200, { nonce: "N1" }),
          token: () => res(202, { status: "pending" }),
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
  });
});
