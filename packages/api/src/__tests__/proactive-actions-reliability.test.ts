import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for F2: runProactiveActions fans out 8 independent checks via
 * Promise.allSettled. allSettled never rejects, so the previous code's outer
 * try/catch could never observe an inner check failure — any check could stop
 * firing with zero log/Sentry signal. The fix inspects each settled result and
 * surfaces rejections (console.warn + captureError) without letting one failure
 * sink the others.
 */

const state = vi.hoisted(() => ({ failingModel: "" }));

// Permissive prisma: every model method resolves to [] so all 8 checks no-op
// early — except the one model whose findMany we deliberately fail.
vi.mock("../db.js", () => {
  const makeModel = (modelName: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) => {
          if (typeof method !== "string") return undefined;
          return vi.fn(async () => {
            if (state.failingModel === modelName && method === "findMany") {
              throw new Error(`boom:${modelName}.${method}`);
            }
            return [];
          });
        },
      },
    );
  const prisma = new Proxy(
    {},
    {
      get: (_t, model) => {
        if (typeof model !== "string") return undefined;
        return makeModel(model);
      },
    },
  );
  return { prisma };
});

vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../notify/sms.js", () => ({ sendSms: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../notify/notification-format.js", () => ({ senderName: vi.fn(() => "Sender") }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { runProactiveActions } from "../proactive-actions.js";
import { captureError } from "../sentry.js";

describe("runProactiveActions reliability (F2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failingModel = "";
  });

  it("surfaces a rejected check instead of swallowing it, and never throws", async () => {
    // checkUnansweredEmails calls prisma.emailMessage.findMany first.
    state.failingModel = "emailMessage";

    await expect(runProactiveActions("user-1")).resolves.toBeUndefined();

    expect(captureError).toHaveBeenCalled();
    const scopes = vi
      .mocked(captureError)
      .mock.calls.map((c) => (c[1] as { tags?: { scope?: string } })?.tags?.scope);
    expect(scopes.some((s) => s?.startsWith("proactive."))).toBe(true);
  });

  it("stays silent when every check succeeds", async () => {
    await expect(runProactiveActions("user-1")).resolves.toBeUndefined();
    expect(captureError).not.toHaveBeenCalled();
  });
});
