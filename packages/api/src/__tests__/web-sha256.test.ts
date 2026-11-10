import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
// The web's plain-JS SHA-256 (the login binding's fallback where crypto.subtle
// is missing). The web package has no unit-test runner, so it is checked here,
// against Node's own implementation, which the API uses to verify the binding.
import { sha256 } from "../../../web/src/lib/sha256.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const nodeSha = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

describe("the web's SHA-256 fallback", () => {
  it("matches the standard test vectors", () => {
    expect(hex(sha256(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches Node's crypto at every length around the block and padding edges", () => {
    for (const length of [1, 43, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const bytes = crypto.randomBytes(length);
      expect(hex(sha256(bytes)), `length ${length}`).toBe(nodeSha(bytes));
    }
  });
});
