/**
 * The reporting path for database failures: what Sentry and the console may
 * carry when a Prisma call fails.
 *
 * A PrismaClientValidationError renders the rejected call, values included
 * (a Slack message's text, a reminder title quoting a mail subject), and a
 * raw-query failure carries Postgres's message, which quotes the bad value.
 * None of that may leave; the class, the error code, model, operation, status
 * and the message's length may.
 */
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { DataWipeFenceError } from "../privacy/data-wipe-fence.js";
import {
  captureDbFailure,
  dbFailureFacts,
  formatDbFailureFacts,
  logDbFailure,
} from "../report-db-failure.js";
import { captureError } from "../sentry.js";
import { callText, reachableText } from "./helpers/canary.js";
import {
  DB_CANARY,
  knownErrorQuotingSubject,
  rawQueryErrorQuotingValue,
  validationErrorQuotingText,
} from "./helpers/prisma-canary.js";

const ESC = String.fromCharCode(0x1b);

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(captureError).mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

const shapes: Array<[string, () => unknown]> = [
  ["a validation error quoting a Slack message", validationErrorQuotingText],
  ["a unique violation quoting a mail subject", knownErrorQuotingSubject],
  ["a raw query failure quoting a value", rawQueryErrorQuotingValue],
  ["a plain Error", () => new Error(`write failed for ${DB_CANARY}`)],
  ["a thrown string", () => `${DB_CANARY} thrown as a string`],
];

describe("the canary premise", () => {
  it.each(shapes)("%s carries the canary", (_label, make) => {
    // If a shape stopped carrying the canary, the tests below would pass vacuously.
    expect(reachableText(make())).toContain(DB_CANARY);
  });
});

describe("dbFailureFacts", () => {
  it("reads class, model and operation from a validation error, never its words", () => {
    const err = validationErrorQuotingText();
    expect(dbFailureFacts(err)).toEqual({
      errorName: "PrismaClientValidationError",
      code: null,
      model: "SlackMessage",
      operation: "create",
      status: null,
      messageLength: err.message.length,
    });
  });

  it("reads the Prisma code and the model Prisma names on a known request error", () => {
    expect(dbFailureFacts(knownErrorQuotingSubject())).toMatchObject({
      errorName: "PrismaClientKnownRequestError",
      code: "P2002",
      model: "Notification",
      operation: "create",
    });
  });

  it("names a raw query by its client method, without a model", () => {
    expect(dbFailureFacts(rawQueryErrorQuotingValue())).toMatchObject({
      code: "P2010",
      model: null,
      operation: "$queryRaw",
    });
  });

  it("reads the invocation header through the colors of errorFormat 'pretty'", () => {
    const err = new Prisma.PrismaClientValidationError(
      `\n${ESC}[31mInvalid ${ESC}[1m\`prisma.reminder.updateMany()\`${ESC}[22m invocation:${ESC}[39m\n\n${DB_CANARY}`,
      { clientVersion: "6.19.3" },
    );
    expect(dbFailureFacts(err)).toMatchObject({ model: "Reminder", operation: "updateMany" });
  });

  it("parses the header only at the start of a Prisma error's message", () => {
    // Content later in the message, or a non-Prisma error that starts the same
    // way, must not be able to name a model.
    const later = new Prisma.PrismaClientValidationError(
      `\nArgument \`text\`: "Invalid \`prisma.${DB_CANARY}.leak()\` invocation"`,
      { clientVersion: "6.19.3" },
    );
    const notPrisma = new Error(`Invalid \`prisma.${DB_CANARY}.leak()\` invocation:`);
    expect(dbFailureFacts(later)).toMatchObject({ model: null, operation: null });
    expect(dbFailureFacts(notPrisma)).toMatchObject({ model: null, operation: null });
  });

  it("drops a model name or code that is not shaped like one", () => {
    const err = new Prisma.PrismaClientKnownRequestError("\nsomething", {
      code: `P2002 ${DB_CANARY}`,
      clientVersion: "6.19.3",
      meta: { modelName: `${DB_CANARY} with spaces` },
    });
    expect(dbFailureFacts(err)).toMatchObject({ code: null, model: null });
  });

  it("keeps a system error's code, but not a code that is free text", () => {
    const reset = Object.assign(new Error(`socket hang up near ${DB_CANARY}`), {
      code: "ECONNRESET",
    });
    const phrase = Object.assign(new Error("x"), { code: `failed for ${DB_CANARY}` });
    expect(dbFailureFacts(reset).code).toBe("ECONNRESET");
    expect(dbFailureFacts(phrase).code).toBeNull();
  });

  it("keeps an HTTP status from a provider call in the same block", () => {
    const gaxios = Object.assign(new Error(`403 for ${DB_CANARY}`), { response: { status: 403 } });
    const webPush = Object.assign(new Error("gone"), { statusCode: 410 });
    const googleapis = Object.assign(new Error("quota"), { code: 429 });
    expect(dbFailureFacts(gaxios).status).toBe(403);
    expect(dbFailureFacts(webPush).status).toBe(410);
    expect(dbFailureFacts(googleapis).status).toBe(429);
  });

  it.each(shapes)("never carries the canary for %s", (_label, make) => {
    const facts = dbFailureFacts(make());
    expect(reachableText(facts)).not.toContain(DB_CANARY);
    expect(formatDbFailureFacts(facts)).not.toContain(DB_CANARY);
  });

  it("formats one log fragment", () => {
    const err = knownErrorQuotingSubject();
    expect(formatDbFailureFacts(dbFailureFacts(err))).toBe(
      `PrismaClientKnownRequestError P2002, model=Notification, operation=create, message ${err.message.length} chars`,
    );
    expect(formatDbFailureFacts(dbFailureFacts("x"))).toBe("UnknownError, message 0 chars");
  });
});

describe("logDbFailure", () => {
  it.each(shapes)("prints label, ids and facts, never the words, for %s", (_label, make) => {
    logDbFailure("[REMINDER] notification create failed", make(), { ids: { reminderId: "r1" } });
    logDbFailure("[SLACK] judging failed", make(), { level: "error" });
    expect(callText(warn)).not.toContain(DB_CANARY);
    expect(callText(error)).not.toContain(DB_CANARY);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /^\[REMINDER\] notification create failed \(reminderId=r1\): /,
    );
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("captureDbFailure", () => {
  it.each(shapes)("sends Sentry a fresh error with the facts for %s", (_label, make) => {
    const err = make();
    captureDbFailure("[REMINDER] notification create failed", err, {
      tags: { scope: "reminder.deliver" },
      extra: { reminderId: "r1" },
    });
    expect(callText(vi.mocked(captureError))).not.toContain(DB_CANARY);
    const [reported, context] = vi.mocked(captureError).mock.calls[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect(reported).not.toBe(err);
    expect((reported as Error).message).toBe(
      `[REMINDER] notification create failed (${dbFailureFacts(err).errorName})`,
    );
    expect(context).toEqual({
      tags: { scope: "reminder.deliver" },
      extra: { reminderId: "r1", ...dbFailureFacts(err) },
    });
  });

  it("keeps the original's stack frames so Sentry still shows where it was thrown", () => {
    const err = validationErrorQuotingText();
    err.stack = `${err.name}: ${err.message}\n    at deliverReminder (reminder-scheduler.ts:60:5)`;
    captureDbFailure("[X] failed", err, { tags: { scope: "x" } });
    const reported = vi.mocked(captureError).mock.calls[0]?.[0] as Error;
    expect(reported.stack).toContain("at deliverReminder (reminder-scheduler.ts:60:5)");
    expect(reported.stack).not.toContain(DB_CANARY);
  });

  it("skips a data-wipe fence rejection, as captureError does", () => {
    captureDbFailure("[X] failed", new DataWipeFenceError(), { tags: { scope: "x" } });
    expect(captureError).not.toHaveBeenCalled();
  });
});
