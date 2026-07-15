import { describe, expect, it } from "vitest";
import {
  computeTraitSourceSig,
  type TraitSourceEmail,
} from "../learning/sender-trait-signature.js";

const sample: TraitSourceEmail[] = [
  { from: "a@x.com", subject: "Hi", snippet: "hello", labels: ["INBOX"] },
  { from: "a@x.com", subject: "Re: Hi", snippet: "thanks", labels: [] },
];

describe("computeTraitSourceSig", () => {
  it("is stable for the same input regardless of label order", () => {
    const a = computeTraitSourceSig([{ ...sample[0], labels: ["INBOX", "UNREAD"] }]);
    const b = computeTraitSourceSig([{ ...sample[0], labels: ["UNREAD", "INBOX"] }]);
    expect(a).toBe(b);
  });

  it("is a 64-char hex sha256", () => {
    expect(computeTraitSourceSig(sample)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the evidence set changes", () => {
    const a = computeTraitSourceSig(sample);
    const b = computeTraitSourceSig([sample[0]]);
    expect(a).not.toBe(b);
  });
});
