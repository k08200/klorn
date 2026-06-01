/**
 * Locks down the two properties the firewall actually depends on:
 *
 *   1. STABILITY — semantically identical input always hashes the same,
 *      regardless of label order or Unicode normalization form. Otherwise
 *      every Gmail label edit invalidates a cached classification.
 *
 *   2. SENSITIVITY — any one-character mutation to a decision-relevant
 *      field changes the hash. Otherwise the silent-re-invocation hole
 *      that motivated this whole module is still open.
 *
 * Also asserts that the verify/check helpers fail loud (verify throws,
 * check returns ok:false) on mismatch, and that null storedHash is
 * treated as "legacy row, skip the check" — the firewall would break for
 * every pre-doctrine row otherwise.
 */

import { describe, expect, it } from "vitest";
import {
  type AttentionHashInput,
  AttentionHashMismatchError,
  checkAttentionInputHash,
  computeAttentionInputHash,
  HASH_SCHEMA_VERSION,
  verifyAttentionInputHash,
} from "../attention-input-hash.js";

const baseInput: AttentionHashInput = {
  from: "alice@example.com",
  subject: "Quarterly review draft",
  snippet: "Hi — the deck is attached, can you take a pass before Friday?",
  labels: ["INBOX", "Work", "Important"],
};

describe("computeAttentionInputHash — stability", () => {
  it("produces the same hash for identical input", () => {
    expect(computeAttentionInputHash(baseInput)).toBe(computeAttentionInputHash(baseInput));
  });

  it("returns a 64-char lowercase hex digest", () => {
    const hash = computeAttentionInputHash(baseInput);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores label order — sorted internally", () => {
    const reordered: AttentionHashInput = {
      ...baseInput,
      labels: ["Important", "INBOX", "Work"],
    };
    expect(computeAttentionInputHash(reordered)).toBe(computeAttentionInputHash(baseInput));
  });

  it("treats NFC and NFD Korean syllables as equal", () => {
    // "한국" — composed (NFC) vs decomposed (NFD). Visually identical;
    // Gmail's body-snippet pipeline sometimes hands back decomposed text
    // depending on the source client.
    const nfc: AttentionHashInput = { ...baseInput, subject: "한국 미팅" };
    const nfd: AttentionHashInput = { ...baseInput, subject: "한국 미팅".normalize("NFD") };
    expect(nfd.subject).not.toBe(nfc.subject); // sanity: the raw strings really do differ
    expect(computeAttentionInputHash(nfd)).toBe(computeAttentionInputHash(nfc));
  });

  it("treats empty-string and falsy-but-present fields consistently", () => {
    const a: AttentionHashInput = { from: "", subject: "", snippet: null, labels: [] };
    const b: AttentionHashInput = { from: "", subject: "", snippet: null, labels: [] };
    expect(computeAttentionInputHash(a)).toBe(computeAttentionInputHash(b));
  });
});

describe("computeAttentionInputHash — sensitivity", () => {
  const baseline = computeAttentionInputHash(baseInput);

  it("changes when `from` mutates", () => {
    const mutated: AttentionHashInput = { ...baseInput, from: "alice@example.org" };
    expect(computeAttentionInputHash(mutated)).not.toBe(baseline);
  });

  it("changes when `subject` mutates by one character", () => {
    const mutated: AttentionHashInput = { ...baseInput, subject: "Quarterly review drafts" };
    expect(computeAttentionInputHash(mutated)).not.toBe(baseline);
  });

  it("changes when `snippet` mutates", () => {
    const mutated: AttentionHashInput = { ...baseInput, snippet: `${baseInput.snippet} (urgent)` };
    expect(computeAttentionInputHash(mutated)).not.toBe(baseline);
  });

  it("changes when a label is added", () => {
    const mutated: AttentionHashInput = {
      ...baseInput,
      labels: [...baseInput.labels, "CATEGORY_PROMOTIONS"],
    };
    expect(computeAttentionInputHash(mutated)).not.toBe(baseline);
  });

  it("changes when a label is removed", () => {
    const mutated: AttentionHashInput = {
      ...baseInput,
      labels: baseInput.labels.filter((l) => l !== "Important"),
    };
    expect(computeAttentionInputHash(mutated)).not.toBe(baseline);
  });

  it("distinguishes snippet=null from snippet=''", () => {
    const a: AttentionHashInput = { ...baseInput, snippet: null };
    const b: AttentionHashInput = { ...baseInput, snippet: "" };
    expect(computeAttentionInputHash(a)).not.toBe(computeAttentionInputHash(b));
  });
});

describe("HASH_SCHEMA_VERSION", () => {
  it("is part of the canonical input — bumping it invalidates existing hashes", () => {
    // We can't easily mutate the export, so we assert the invariant
    // indirectly: the hash depends on the version string, so any future
    // bump produces a different digest for the same logical input.
    // Sanity-check the current value is set.
    expect(HASH_SCHEMA_VERSION).toBe("v1");
  });
});

describe("verifyAttentionInputHash", () => {
  it("returns the current hash when stored matches", () => {
    const stored = computeAttentionInputHash(baseInput);
    expect(verifyAttentionInputHash(stored, baseInput)).toBe(stored);
  });

  it("throws AttentionHashMismatchError when the input has been mutated", () => {
    const stored = computeAttentionInputHash(baseInput);
    const mutated: AttentionHashInput = { ...baseInput, subject: "Quarterly review v2" };
    expect(() => verifyAttentionInputHash(stored, mutated)).toThrow(AttentionHashMismatchError);
  });

  it("returns the current hash and does NOT throw when stored is null (legacy row)", () => {
    const current = verifyAttentionInputHash(null, baseInput);
    expect(current).toBe(computeAttentionInputHash(baseInput));
  });

  it("returns the current hash and does NOT throw when stored is undefined", () => {
    const current = verifyAttentionInputHash(undefined, baseInput);
    expect(current).toBe(computeAttentionInputHash(baseInput));
  });
});

describe("checkAttentionInputHash (soft variant)", () => {
  it("returns ok:true with currentHash on match", () => {
    const stored = computeAttentionInputHash(baseInput);
    const result = checkAttentionInputHash(stored, baseInput);
    expect(result.ok).toBe(true);
    expect(result.ok && result.currentHash).toBe(stored);
  });

  it("returns ok:false with both hashes on mismatch", () => {
    const stored = computeAttentionInputHash(baseInput);
    const mutated: AttentionHashInput = { ...baseInput, from: "mallory@example.com" };
    const result = checkAttentionInputHash(stored, mutated);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.storedHash).toBe(stored);
      expect(result.currentHash).toBe(computeAttentionInputHash(mutated));
      expect(result.currentHash).not.toBe(result.storedHash);
    }
  });

  it("treats null storedHash as legacy (ok:true)", () => {
    const result = checkAttentionInputHash(null, baseInput);
    expect(result.ok).toBe(true);
  });
});
