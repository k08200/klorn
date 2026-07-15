/**
 * judge-dial: the model-routing / escalation policy. The dial must be OFF by
 * default (env unset) so the judge stays a single-model call, and must only
 * escalate on the cheap model's blind spot (low confidence) for the normal,
 * non-pinned classification path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ESCALATION_CONFIDENCE_FLOOR,
  escalationModel,
  resolveEscalation,
} from "../judge/judge-dial.js";

const ENV_KEY = "JUDGE_ESCALATION_MODEL";
const BASE = "google/gemini-2.5-flash";
const STRONG = "anthropic/claude-opus-4";

describe("judge-dial", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  describe("escalationModel", () => {
    it("is null when the dial is off (env unset)", () => {
      expect(escalationModel()).toBeNull();
    });
    it("trims and returns the configured model", () => {
      process.env[ENV_KEY] = `  ${STRONG}  `;
      expect(escalationModel()).toBe(STRONG);
    });
    it("treats a blank env as off", () => {
      process.env[ENV_KEY] = "   ";
      expect(escalationModel()).toBeNull();
    });
  });

  describe("resolveEscalation", () => {
    const lowConf = ESCALATION_CONFIDENCE_FLOOR - 0.1;
    const highConf = ESCALATION_CONFIDENCE_FLOOR;

    it("returns null when the dial is off, even on low confidence", () => {
      expect(
        resolveEscalation({ confidence: lowConf, callerPinnedModel: false, baseModel: BASE }),
      ).toBeNull();
    });

    it("escalates on low confidence when a model is configured", () => {
      process.env[ENV_KEY] = STRONG;
      expect(
        resolveEscalation({ confidence: lowConf, callerPinnedModel: false, baseModel: BASE }),
      ).toBe(STRONG);
    });

    it("does not escalate when the cheap model was confident", () => {
      process.env[ENV_KEY] = STRONG;
      expect(
        resolveEscalation({ confidence: highConf, callerPinnedModel: false, baseModel: BASE }),
      ).toBeNull();
    });

    it("does not escalate when the caller pinned a model", () => {
      process.env[ENV_KEY] = STRONG;
      expect(
        resolveEscalation({ confidence: lowConf, callerPinnedModel: true, baseModel: BASE }),
      ).toBeNull();
    });

    it("does not escalate to the same model already used", () => {
      process.env[ENV_KEY] = BASE;
      expect(
        resolveEscalation({ confidence: lowConf, callerPinnedModel: false, baseModel: BASE }),
      ).toBeNull();
    });
  });
});
