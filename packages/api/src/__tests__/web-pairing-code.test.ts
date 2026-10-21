import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { pairingCode } from "../auth/desktop-confirm.js";
// The web's pairing code (shown in the app while the browser asks for
// confirmation) must equal the one the API's confirmation page shows.
import { pairingCodeOf } from "../../../web/src/lib/pairing-code.js";

describe("the app's pairing code and the browser's", () => {
  it("agree for any nonce", () => {
    for (let i = 0; i < 200; i++) {
      const nonce = crypto.randomBytes(32).toString("hex");
      expect(pairingCodeOf(nonce), nonce).toBe(pairingCode(nonce));
    }
  });
});
