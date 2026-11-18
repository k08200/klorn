/**
 * NT0 notification presentation (copy spec 2026-11-17): structured fields on
 * every channel, the APNs layout behind NOTIFY_PUSH_PRESENTATION, and mail /
 * meeting content (the verified quote, the join link on APNs / FCM) behind
 * NOTIFY_PUSH_QUOTE. Pure builders; the channel cut runs per user.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    devicePushToken: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({})) },
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { buildApnsBody, apnsPriorityFor } = await import("../notify/push-apns.js");
const { buildFcmMessage } = await import("../notify/push-device.js");
const { presentationForChannels, defaultKind } = await import("../notify/push-presentation.js");

const MAIL = {
  title: "Terry Smith",
  body: "견적서 최종 확인\nSignature needed today",
  url: "/email/e1",
  emailId: "e1",
  lane: "PUSH" as const,
};
const PUSH_FIELDS = {
  kind: "push" as const,
  senderDisplayName: "Terry Smith",
  subject: "견적서 최종 확인",
  reasonLine: "Signature needed today",
  threadId: "t-1",
};

beforeEach(() => {
  delete process.env.NOTIFY_PUSH_QUOTE;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});
afterEach(() => {
  delete process.env.NOTIFY_PUSH_QUOTE;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("APNs", () => {
  it("appends the fields as top-level custom keys after every existing key; alert unchanged by default", () => {
    const body = JSON.parse(buildApnsBody({ ...MAIL, presentation: PUSH_FIELDS }, "email_urgent"));
    expect(body.aps.alert).toEqual({ title: MAIL.title, body: MAIL.body });
    expect(body.aps["interruption-level"]).toBeUndefined();
    expect(body.aps["thread-id"]).toBeUndefined();
    expect(Object.keys(body)).toEqual([
      "aps",
      "url",
      "category",
      "emailId",
      "route",
      "lane",
      "kind",
      "senderDisplayName",
      "subject",
      "reasonLine",
      "threadId",
    ]);
  });

  it("presentation on: title / subtitle / request, thread-id, interruption level and relevance", () => {
    const body = JSON.parse(
      buildApnsBody({ ...MAIL, presentation: PUSH_FIELDS }, "email_urgent", { presentation: true }),
    );
    expect(body.aps.alert).toEqual({
      title: "Terry Smith",
      subtitle: "견적서 최종 확인",
      body: "Signature needed today",
    });
    expect(body.aps).toMatchObject({
      "thread-id": "thread:t-1",
      "interruption-level": "time-sensitive",
      "relevance-score": 1,
      category: "KLORN_PUSH_MAIL",
    });
  });

  it("presentation on: a verified quote is the body, in curly quotes", () => {
    const body = JSON.parse(
      buildApnsBody(
        { ...MAIL, presentation: { ...PUSH_FIELDS, quote: "오늘 17시까지 회신 부탁드립니다" } },
        "email_urgent",
        { presentation: true },
      ),
    );
    expect(body.aps.alert.body).toBe("“오늘 17시까지 회신 부탁드립니다”");
  });

  it("presentation on: a digest is passive, grouped by kind, sent at priority 5", () => {
    const payload = {
      title: "답장 대기 4건",
      body: "a\nb",
      presentation: { kind: "digest" as const },
    };
    const body = JSON.parse(buildApnsBody(payload, "agent_proposal", { presentation: true }));
    expect(body.aps.alert).toEqual({ title: "답장 대기 4건", body: "a\nb" });
    expect(body.aps).toMatchObject({
      "interruption-level": "passive",
      "thread-id": "kind:digest",
      "relevance-score": 0.2,
    });
    expect(apnsPriorityFor(payload, true)).toBe("5");
    expect(apnsPriorityFor(payload, false)).toBe("10");
    expect(apnsPriorityFor({ ...MAIL, presentation: PUSH_FIELDS }, true)).toBe("10");
    expect(apnsPriorityFor({ title: "x", body: "y" }, true)).toBe("10");
  });

  it("a push without fields is byte-identical to before, presentation on or off", () => {
    const plain = { title: "Klorn", body: "Done", url: "/today" };
    expect(buildApnsBody(plain, "system", { presentation: true })).toBe(
      buildApnsBody(plain, "system"),
    );
  });
});

describe("FCM", () => {
  it("data carries the fields as strings, the Android channel and the group key", () => {
    const msg = buildFcmMessage(
      "tok",
      { ...MAIL, presentation: { ...PUSH_FIELDS, kind: "meet", attendeeCount: 3 } },
      "email_urgent",
    );
    expect(msg.data).toMatchObject({
      kind: "meet",
      channelId: "meetings",
      groupKey: "thread:t-1",
      senderDisplayName: "Terry Smith",
      subject: "견적서 최종 확인",
      reasonLine: "Signature needed today",
      threadId: "t-1",
      attendeeCount: "3",
    });
    expect(Object.values(msg.data ?? {}).every((v) => typeof v === "string")).toBe(true);
  });

  it("maps every kind to its channel", () => {
    const channel = (kind: "push" | "meet" | "wait" | "digest" | "brief" | "agent" | "acct") =>
      buildFcmMessage("tok", { title: "t", body: "b", presentation: { kind } }, "system").data
        ?.channelId;
    expect(channel("push")).toBe("push");
    expect(channel("meet")).toBe("meetings");
    expect(channel("wait")).toBe("waiting");
    expect(channel("digest")).toBe("waiting");
    expect(channel("agent")).toBe("waiting");
    expect(channel("brief")).toBe("briefing");
    expect(channel("acct")).toBe("account");
  });

  it("a push without fields keeps exactly its old data keys", () => {
    const msg = buildFcmMessage("tok", { title: "t", body: "b", url: "/x" }, "system");
    expect(msg.data).toEqual({ url: "/x", category: "system" });
  });
});

describe("presentationForChannels", () => {
  const meet = {
    kind: "meet" as const,
    joinUrl: "https://meet.google.com/abc-defg-hij",
    attendeeCount: 3,
  };

  it("NOTIFY_PUSH_QUOTE off: no quote anywhere; the join link only on web push", () => {
    const out = presentationForChannels(
      "u1",
      { ...PUSH_FIELDS, quote: "please sign" },
      "email_urgent",
    );
    expect(out.web?.quote).toBeUndefined();
    expect(out.native?.quote).toBeUndefined();
    const m = presentationForChannels("u1", meet, "meeting");
    expect(m.web?.joinUrl).toBe(meet.joinUrl);
    expect(m.native?.joinUrl).toBeUndefined();
    expect(m.native?.attendeeCount).toBe(3);
  });

  it("NOTIFY_PUSH_QUOTE on (or the cohort user): the quote and the join link on every channel", () => {
    process.env.NOTIFY_PUSH_QUOTE = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "u1";
    const out = presentationForChannels(
      "u1",
      { ...PUSH_FIELDS, quote: "please sign" },
      "email_urgent",
    );
    expect(out.native?.quote).toBe("please sign");
    expect(presentationForChannels("u1", meet, "meeting").native?.joinUrl).toBe(meet.joinUrl);
    expect(presentationForChannels("u2", meet, "meeting").native?.joinUrl).toBeUndefined();
  });

  it("drops a join link that is not https or too long", () => {
    process.env.NOTIFY_PUSH_QUOTE = "on";
    const bad = (joinUrl: string) =>
      presentationForChannels("u1", { kind: "meet", joinUrl }, "meeting").web?.joinUrl;
    expect(bad("http://meet.example.com/x")).toBeUndefined();
    expect(bad("javascript:alert(1)")).toBeUndefined();
    expect(bad(`https://zoom.us/j/1?pwd=${"x".repeat(600)}`)).toBeUndefined();
  });

  it("names a kind from the category only where it is unambiguous", () => {
    expect(defaultKind("email_urgent")).toBe("push");
    expect(defaultKind("daily_briefing")).toBe("brief");
    expect(defaultKind("agent_proposal")).toBe("agent");
    expect(defaultKind("meeting")).toBeUndefined();
    expect(defaultKind("system")).toBeUndefined();
    expect(presentationForChannels("u1", undefined, "system")).toEqual({});
    expect(presentationForChannels("u1", undefined, "email_urgent").web).toEqual({ kind: "push" });
  });
});
