import { describe, expect, it } from "vitest";
import { extractWsSubprotocolToken, WS_AUTH_SUBPROTOCOL } from "../websocket.js";

describe("extractWsSubprotocolToken", () => {
  it("returns the token that follows the marker (comma-joined header)", () => {
    expect(extractWsSubprotocolToken(`${WS_AUTH_SUBPROTOCOL}, my.jwt-token_abc`)).toBe(
      "my.jwt-token_abc",
    );
  });

  it("handles a header delivered as a string array", () => {
    expect(extractWsSubprotocolToken([WS_AUTH_SUBPROTOCOL, "tok"])).toBe("tok");
  });

  it("returns null when the marker is absent (legacy query-param client)", () => {
    expect(extractWsSubprotocolToken("some-other-protocol")).toBeNull();
    expect(extractWsSubprotocolToken(undefined)).toBeNull();
    expect(extractWsSubprotocolToken("")).toBeNull();
  });

  it("returns null when the marker is present but carries no token value", () => {
    expect(extractWsSubprotocolToken(WS_AUTH_SUBPROTOCOL)).toBeNull();
  });
});

describe("websocket auth — subprotocol is the only credential channel", () => {
  it("the connection handler no longer reads the legacy ?token= query param", async () => {
    // Regression guard for the fallback removal: the query fallback leaked
    // long-lived JWTs into proxy/LB access logs. Every shipped client (web,
    // macOS, and the shells wrapping web) offers the subprotocol, so a
    // ?token= read must never come back. Source-level pin: this is a pure
    // string assertion because the handler is only reachable over a real
    // socket, which the unit harness doesn't open.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../websocket.ts", import.meta.url), "utf8");
    expect(src).not.toContain('searchParams.get("token")');
  });
});
