/**
 * A Resend key that cannot read received mail (401/403 on `receiving.get` or
 * `.forward`) must reach an operator: the delivery still answers retry (503),
 * and the process reports it to Sentry once, with the status only (step E1b of
 * docs/providers/unified-platform-plan.md).
 *
 * Its own file: the report is once per process (module state), so the tests
 * below run in order against one module instance and count across requests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db-tenant.js", () => ({
  withSystem: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      klornAddress: {
        findMany: vi.fn(async () => [{ handle: "jane", userId: "u-jane" }]),
      },
    }),
  ),
  withTenant: vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      linkedInboxAccount: { findFirst: vi.fn(async () => ({ id: "lia-jane" })) },
      dataWipe: { findUnique: vi.fn(async () => null) },
      emailMessage: { findUnique: vi.fn(async () => null) },
    }),
  ),
}));
const persistGmailEmail = vi.hoisted(() => vi.fn());
vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail }));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { deliverInboundEmail, RESEND_AUTH_SCOPE } from "../mail/klorn-inbound.js";

const API_KEY = "re_test_inbound_full_access";
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const SETTINGS = { domain: "klorn.ai", forwardTo: "support-inbox@example.com", timeoutMs: 1_000 };

function eventData(to: string[]) {
  return {
    email_id: EMAIL_ID,
    created_at: "2026-10-22T10:00:00.000Z",
    from: "sender@example.com",
    to,
    cc: [],
    bcc: [],
    received_for: [],
    message_id: "<m1@example.com>",
    subject: "Hi",
    attachments: [],
  };
}

function failing(statusCode: number) {
  return {
    data: null,
    error: { statusCode, name: "restricted_api_key" as const, message: `key ${API_KEY}` },
    headers: {},
  };
}

const get = vi.fn();
const forward = vi.fn();
const api = { get, forward };

function authReports() {
  return captureError.mock.calls.filter(
    ([, context]) => context?.tags?.scope === RESEND_AUTH_SCOPE,
  );
}

beforeEach(() => {
  get.mockReset();
  forward.mockReset();
  persistGmailEmail.mockReset();
  persistGmailEmail.mockResolvedValue({ emailId: "row", isNew: true });
});

describe("a Resend key that cannot read received mail", () => {
  it("is not what a 5xx, a 429 or a 404 reports", async () => {
    for (const status of [500, 429, 404]) {
      get.mockResolvedValueOnce(failing(status));
      await deliverInboundEmail(eventData(["jane@klorn.ai"]), SETTINGS, api);
    }
    expect(authReports()).toHaveLength(0);
  });

  it("answers retry and reports a 401 on get once, with the status only", async () => {
    get.mockResolvedValue(failing(401));
    const outcome = await deliverInboundEmail(eventData(["jane@klorn.ai"]), SETTINGS, api);

    expect(outcome.retry).toBe("resend-get-401");
    const reports = authReports();
    expect(reports).toHaveLength(1);
    const [error, context] = reports[0];
    expect(context).toEqual({ tags: { scope: RESEND_AUTH_SCOPE }, extra: { status: 401 } });
    const reported = `${String(error)} ${JSON.stringify(context)}`;
    expect(reported).not.toContain(API_KEY);
    expect(reported).not.toContain("@");
    expect(reported).not.toContain(EMAIL_ID);
  });

  it("does not report again for later requests, on get or forward, 401 or 403", async () => {
    get.mockResolvedValue(failing(403));
    forward.mockResolvedValue(failing(401));
    for (let i = 0; i < 3; i++) {
      const outcome = await deliverInboundEmail(
        eventData(["jane@klorn.ai", "postmaster@klorn.ai"]),
        SETTINGS,
        api,
      );
      expect(outcome.retry).not.toBeNull();
    }
    expect(forward).toHaveBeenCalledTimes(3);
    expect(authReports()).toHaveLength(1);
  });

  it("is reported for a 403 on forward alone, in a fresh process", async () => {
    vi.resetModules();
    const fresh = await import("../mail/klorn-inbound.js");
    captureError.mockClear();
    forward.mockResolvedValue(failing(403));
    const outcome = await fresh.deliverInboundEmail(
      eventData(["postmaster@klorn.ai"]),
      SETTINGS,
      api,
    );

    expect(outcome.retry).toBe("resend-forward-403");
    expect(get).not.toHaveBeenCalled();
    expect(authReports()).toHaveLength(1);
    expect(authReports()[0][1]).toEqual({
      tags: { scope: RESEND_AUTH_SCOPE },
      extra: { status: 403 },
    });
  });
});
