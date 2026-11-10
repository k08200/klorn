/**
 * The Sent scan through the REAL folder mapping (gmail-mailbox.ts), Gmail
 * mocked. A message whose internalDate is null or "" was mapped to epoch 0
 * (Number(null) === Number("") === 0), and syncSentMessages recorded it with
 * sentAt 1970-01-01 — epoch 0 is not NaN, so its NaN guard never fired. Same
 * rule as the Sent-history import (#1600): internalDate, else the Date
 * header, else the row is not recorded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  upserts: [] as { create: { gmailId: string; sentAt: Date } }[],
  captured: [] as unknown[],
  messages: [] as {
    id: string;
    internalDate: string | null;
    date: string | null;
  }[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    sentMessage: {
      upsert: vi.fn(async (args: { create: { gmailId: string; sentAt: Date } }) => {
        state.upserts.push(args);
        return {};
      }),
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown) => {
    state.captured.push(err);
  }),
}));

vi.mock("../mail/sent-origin-classifier.js", () => ({
  classifySentRows: vi.fn(async () => new Map()),
}));

vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({ key: "primary" })),
  getAuthedInboxClient: vi.fn(async () => null),
  getLinkedInboxClients: vi.fn(async () => []),
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: vi.fn(async () => ({
            data: { messages: state.messages.map(({ id }) => ({ id })), nextPageToken: null },
          })),
          get: vi.fn(async (params: { id: string }) => {
            const m = state.messages.find((msg) => msg.id === params.id);
            return {
              data: {
                id: params.id,
                threadId: `t-${params.id}`,
                labelIds: ["SENT"],
                internalDate: m?.internalDate ?? null,
                payload: {
                  headers: [
                    { name: "To", value: "you@example.com" },
                    { name: "Subject", value: `Subject ${params.id}` },
                    ...(m?.date ? [{ name: "Date", value: m.date }] : []),
                  ],
                },
              },
            };
          }),
        },
      },
    })),
    auth: { OAuth2: class {} },
  },
}));

import { resetSentSyncThrottleForTests, syncSentMessages } from "../mail/sent-messages.js";

const NOW = new Date("2026-11-04T00:00:00Z").getTime();
const HEADER = "Tue, 26 Aug 2026 09:00:00 +0900";

describe("syncSentMessages — a Sent message with no internalDate", () => {
  beforeEach(() => {
    state.upserts.length = 0;
    state.captured.length = 0;
    resetSentSyncThrottleForTests();
  });

  it.each([
    ["null", null],
    ['""', ""],
  ])("internalDate %s: records the Date header's time, never 1970", async (_label, missing) => {
    state.messages = [{ id: "g1", internalDate: missing, date: HEADER }];
    expect(await syncSentMessages("u1", NOW)).toBe(1);
    expect(state.upserts[0].create).toMatchObject({
      gmailId: "g1",
      sentAt: new Date(Date.parse(HEADER)),
    });
  });

  it.each([
    ["null", null],
    ['""', ""],
  ])("internalDate %s and no usable Date header: records nothing", async (_label, missing) => {
    state.messages = [
      { id: "no-header", internalDate: missing, date: null },
      { id: "bad-header", internalDate: missing, date: "not a date" },
    ];
    expect(await syncSentMessages("u1", NOW)).toBe(0);
    expect(state.upserts).toEqual([]);
    expect(state.captured).toEqual([]);
  });

  it("a valid internalDate is still the sentAt, Date header or not", async () => {
    state.messages = [{ id: "g1", internalDate: "1756100000000", date: HEADER }];
    expect(await syncSentMessages("u1", NOW)).toBe(1);
    expect(state.upserts[0].create).toMatchObject({
      gmailId: "g1",
      sentAt: new Date(1756100000000),
    });
  });
});
