/**
 * llmCallerFeature names the app module that made an LLM call, so the usage
 * ledger can say which feature spent the money without every call site having
 * to pass a label (and without new call sites going unattributed).
 */

import { describe, expect, it } from "vitest";
import { callerFeatureFromStack, llmCallerFeature } from "../llm/llm-caller.js";

const devStack = `Error
    at llmCallerFeature (/Users/me/klorn/packages/api/src/llm/llm-caller.ts:20:15)
    at createCompletion (/Users/me/klorn/packages/api/src/llm/openai.ts:460:20)
    at estimate (/Users/me/klorn/packages/api/src/billing/llm-usage.ts:90:3)
    at summarizeEmail (/Users/me/klorn/packages/api/src/mail/email-summarize.ts:301:24)
    at runTick (/Users/me/klorn/packages/api/src/automation-scheduler.ts:1500:9)`;

const prodStack = `Error
    at llmCallerFeature (file:///app/packages/api/dist/llm/llm-caller.js:12:15)
    at createCompletion (file:///app/packages/api/dist/llm/openai.js:300:20)
    at async judgeEmail (file:///app/packages/api/dist/judge/poc-judge.js:420:24)`;

describe("callerFeatureFromStack", () => {
  it("names the first module outside the LLM and billing plumbing (source paths)", () => {
    expect(callerFeatureFromStack(devStack)).toBe("mail/email-summarize");
  });

  it("names the module from compiled paths, including async frames", () => {
    expect(callerFeatureFromStack(prodStack)).toBe("judge/poc-judge");
  });

  it("skips providers, node internals and dependencies", () => {
    const stack = `Error
    at x (/app/packages/api/dist/providers/anthropic-native.js:1:1)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at y (/app/node_modules/openai/core.js:10:2)
    at /app/packages/api/dist/routes/email-replies.js:250:7`;
    expect(callerFeatureFromStack(stack)).toBe("routes/email-replies");
  });

  it("reads anonymous async frames", () => {
    const stack = `Error
    at createCompletion (file:///app/packages/api/dist/llm/openai.js:300:20)
    at async file:///app/packages/api/dist/automation-scheduler.js:1500:9`;
    expect(callerFeatureFromStack(stack)).toBe("automation-scheduler");
  });

  it("returns null when no app module is on the stack", () => {
    const stack = `Error
    at createCompletion (/app/packages/api/dist/llm/openai.js:300:20)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;
    expect(callerFeatureFromStack(stack)).toBeNull();
    expect(callerFeatureFromStack(undefined)).toBeNull();
  });
});

describe("llmCallerFeature", () => {
  function callerInThisFile(): string | null {
    return llmCallerFeature();
  }

  it("reads the live stack and names the calling module", () => {
    expect(callerInThisFile()).toBe("__tests__/llm-caller.test");
  });
});

describe("llmCallerFeature never fails the call it labels", () => {
  it("returns null when the runtime hands back a non-string stack", () => {
    const original = Error.prepareStackTrace;
    Error.prepareStackTrace = () => 42;
    try {
      expect(llmCallerFeature()).toBeNull();
    } finally {
      Error.prepareStackTrace = original;
    }
  });
});
