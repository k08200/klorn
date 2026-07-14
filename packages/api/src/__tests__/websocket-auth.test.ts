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
