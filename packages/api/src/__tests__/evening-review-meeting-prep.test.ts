/**
 * Evening review + meeting prep (Context Engine slice 1): when the flag is on
 * and a meeting tomorrow morning has something to prep, the review carries its
 * prep lines — and that alone is reason enough to send. Afternoon meetings and
 * the flag off leave the review exactly as before.
 */

import type { MeetingPrep, MeetingPrepBlock } from "@klorn/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  block: null as MeetingPrepBlock | null,
  calls: [] as string[],
}));

vi.mock("../db.js", () => {
  const model = () =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async () => (method === "findMany" ? [] : method === "count" ? 0 : null)),
      },
    );
  const prisma = new Proxy({}, { get: () => model() });
  return { prisma, db: prisma };
});
vi.mock("../context/meeting-prep-surface.js", () => ({
  meetingPrepForUser: vi.fn(async (userId: string) => {
    m.calls.push(userId);
    return m.block;
  }),
}));

import {
  composeEveningReview,
  type EveningReviewInput,
  gatherEveningReviewInput,
} from "../agentcore/evening-review.js";

const TZ = "Asia/Seoul";
/** 18:05 KST on 2099-01-05. */
const EVENING = new Date("2099-01-05T09:05:00Z");

function prep(
  eventId: string,
  startIso: string,
  overrides: Partial<MeetingPrep> = {},
): MeetingPrep {
  return {
    eventId,
    title: "Acme sync",
    startTime: startIso,
    endTime: new Date(Date.parse(startIso) + 60 * 60 * 1000).toISOString(),
    attendees: ["alice@acme.com"],
    items: [
      {
        kind: "commitment",
        owner: "USER",
        title: "Send the quote",
        dueAt: "2099-01-09T09:00:00.000Z",
        confirmed: true,
        counterpartyName: "Alice",
        match: "address",
        source: { kind: "commitment", commitmentId: "c-1" },
      },
    ],
    ...overrides,
  };
}

const empty: EveningReviewInput = {
  unanswered: [],
  commitments: [],
  theyOwe: [],
  firstMeetingTomorrow: null,
};

beforeEach(() => {
  m.block = null;
  m.calls = [];
});

describe("composeEveningReview with meeting prep", () => {
  // 10:30 KST tomorrow: after the 10:00 early-start cutoff, so without prep nothing sends.
  const morning = prep("ev-1", "2099-01-06T01:30:00.000Z");

  it("prep alone sends the review, titled as prep, with the sourced lines", () => {
    const review = composeEveningReview({ ...empty, meetingPrep: [morning] }, "en", TZ);
    expect(review?.title).toBe("Prep for tomorrow morning");
    expect(review?.message).toContain("Before 10:30 AM Acme sync");
    expect(review?.message).toContain("• You promised: Send the quote (by Fri, Jan 9)");
    expect(review?.pushBody).toBe("Before 10:30 AM Acme sync");
  });

  it("with open items the title still counts them, and prep follows the open sections", () => {
    const review = composeEveningReview(
      {
        ...empty,
        unanswered: [{ id: "e1", from: "Bob <bob@x.com>", subject: "Contract" }],
        meetingPrep: [morning],
      },
      "en",
      TZ,
    );
    expect(review?.title).toBe("1 thing still open today");
    const message = review?.message ?? "";
    expect(message.indexOf("Contract")).toBeLessThan(message.indexOf("Before 10:30 AM"));
    expect(review?.pushBody.length).toBeLessThanOrEqual(200);
  });

  it("does not repeat tomorrow's first meeting when prep already names it", () => {
    const review = composeEveningReview(
      {
        ...empty,
        firstMeetingTomorrow: { title: "Acme sync", startTime: new Date(morning.startTime) },
        meetingPrep: [morning],
      },
      "en",
      TZ,
    );
    expect(review?.message).not.toContain("Tomorrow starts at");
  });

  it("a prep meeting with no items says nothing", () => {
    expect(
      composeEveningReview({ ...empty, meetingPrep: [{ ...morning, items: [] }] }, "en", TZ),
    ).toBeNull();
  });

  it("prep with only a recent thread or a suggestion never rings, but rides along", () => {
    const fyi = prep("ev-2", "2099-01-06T01:30:00.000Z", {
      items: [
        {
          kind: "thread",
          from: "Alice",
          subject: "Notes",
          receivedAt: "2099-01-04T00:00:00.000Z",
          match: "address",
          source: { kind: "email", emailId: "m-9" },
        },
        {
          kind: "commitment",
          owner: "COUNTERPARTY",
          title: "Signed NDA",
          dueAt: null,
          confirmed: false,
          counterpartyName: null,
          match: "domain",
          source: { kind: "commitment", commitmentId: "c-9" },
        },
      ],
    });
    expect(composeEveningReview({ ...empty, meetingPrep: [fyi] }, "en", TZ)).toBeNull();
    const withOpen = composeEveningReview(
      {
        ...empty,
        unanswered: [{ id: "e1", from: "Bob <bob@x.com>", subject: "Contract" }],
        meetingPrep: [fyi],
      },
      "en",
      TZ,
    );
    expect(withOpen?.message).toContain("Recent: Alice — Notes");
  });

  it("follows the notification language", () => {
    const review = composeEveningReview({ ...empty, meetingPrep: [morning] }, "ko", TZ);
    expect(review?.title).toBe("내일 오전 회의 준비");
  });
});

describe("gatherEveningReviewInput", () => {
  it("keeps only tomorrow-morning meetings from the prep block", async () => {
    m.block = {
      generatedAt: EVENING.toISOString(),
      meetings: [
        prep("today-late", "2099-01-05T11:00:00.000Z"), // 20:00 KST today
        prep("tomorrow-9", "2099-01-06T00:00:00.000Z"), // 09:00 KST tomorrow
        prep("tomorrow-11", "2099-01-06T02:30:00.000Z"), // 11:30 KST tomorrow
        prep("tomorrow-14", "2099-01-06T05:00:00.000Z"), // 14:00 KST tomorrow
      ],
    };
    const input = await gatherEveningReviewInput("u1", TZ, EVENING);
    expect(input.meetingPrep?.map((p) => p.eventId)).toEqual(["tomorrow-9", "tomorrow-11"]);
    expect(m.calls).toEqual(["u1"]);
  });

  it("no block (flag off or nothing to prep) means no prep", async () => {
    const input = await gatherEveningReviewInput("u1", TZ, EVENING);
    expect(input.meetingPrep).toEqual([]);
    expect(composeEveningReview(input, "en", TZ)).toBeNull();
  });
});
