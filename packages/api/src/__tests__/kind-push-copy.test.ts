/**
 * NT0 canonical copy (decide-board gen_nt.py, decided 2026-11-17) for the
 * kinds that were still on their old text: meet, brief, agent, acct. Pure
 * builders; each producer uses them only while NOTIFY_PUSH_PRESENTATION is open
 * to the user (the producer tests pin that, and that flag off is unchanged).
 */
import { describe, expect, it } from "vitest";
import {
  acctPushCopy,
  agentDraftPushCopy,
  briefPushCopy,
  meetPushCopy,
} from "../notify/kind-push-copy.js";
import { joinProviderName } from "../notify/push-presentation.js";

describe("meet: title = the event, body = relative start · provider · how many", () => {
  it("reads the board's Korean example", () => {
    expect(
      meetPushCopy({
        eventTitle: "디자인 리뷰",
        startsInMinutes: 10,
        joinUrl: "https://meet.google.com/abc-defg-hij",
        attendeeCount: 3,
        language: "ko",
      }),
    ).toEqual({ title: "디자인 리뷰", body: "10분 후 · Google Meet · 3명" });
  });

  it("speaks English and Chinese with their own plurals", () => {
    const base = {
      eventTitle: "Design review",
      joinUrl: "https://acme.zoom.us/j/123",
    };
    expect(meetPushCopy({ ...base, startsInMinutes: 5, attendeeCount: 1, language: "en" })).toEqual(
      { title: "Design review", body: "In 5 min · Zoom · 1 person" },
    );
    expect(
      meetPushCopy({ ...base, startsInMinutes: 5, attendeeCount: 4, language: "en" }).body,
    ).toBe("In 5 min · Zoom · 4 people");
    expect(
      meetPushCopy({ ...base, startsInMinutes: 5, attendeeCount: 4, language: "zh" }).body,
    ).toBe("5分钟后 · Zoom · 4人");
  });

  it("names whole hours and hours with minutes for the T-60 heads-up", () => {
    const at = (startsInMinutes: number, language: string) =>
      meetPushCopy({ eventTitle: "Sync", startsInMinutes, language }).body;
    expect(at(60, "en")).toBe("In 1 hr");
    expect(at(62, "en")).toBe("In 1 hr 2 min");
    expect(at(60, "ko")).toBe("1시간 후");
    expect(at(62, "ko")).toBe("1시간 2분 후");
    expect(at(62, "zh")).toBe("1小时2分钟后");
    expect(at(0, "en")).toBe("Starting now");
    expect(at(0, "ko")).toBe("지금 시작");
  });

  it("leaves out the provider without a known join link and the count when unknown", () => {
    expect(
      meetPushCopy({
        eventTitle: "Lunch",
        startsInMinutes: 3,
        joinUrl: "https://evil.example/zoom.us",
        attendeeCount: null,
        language: "en",
      }),
    ).toEqual({ title: "Lunch", body: "In 3 min" });
  });

  it("cleans the event title onto one line and falls back when it is empty", () => {
    expect(
      meetPushCopy({ eventTitle: "<b>Board</b>\nreview", startsInMinutes: 3, language: "en" })
        .title,
    ).toBe("Board review");
    expect(meetPushCopy({ eventTitle: "  ", startsInMinutes: 3, language: "ko" }).title).toBe(
      "회의",
    );
    expect(meetPushCopy({ eventTitle: null, startsInMinutes: 3, language: "zh" }).title).toBe(
      "会议",
    );
  });

  it("names every allowlisted join host, and nothing else", () => {
    expect(joinProviderName("https://meet.google.com/x")).toBe("Google Meet");
    expect(joinProviderName("https://us02web.zoom.us/j/1")).toBe("Zoom");
    expect(joinProviderName("https://teams.microsoft.com/l/x")).toBe("Microsoft Teams");
    expect(joinProviderName("https://teams.live.com/meet/1")).toBe("Microsoft Teams");
    expect(joinProviderName("https://acme.webex.com/meet/x")).toBe("Webex");
    expect(joinProviderName("https://whereby.com/room")).toBe("Whereby");
    expect(joinProviderName("http://meet.google.com/x")).toBeUndefined();
    expect(joinProviderName("https://meet.google.com.evil.example/x")).toBeUndefined();
    expect(joinProviderName(undefined)).toBeUndefined();
  });
});

describe("brief: today's briefing and its three counts", () => {
  it("reads the board's Korean example", () => {
    expect(briefPushCopy({ urgentMail: 2, meetings: 3, freeHours: 5 }, "ko")).toEqual({
      title: "오늘 브리핑",
      body: "급한 메일 2 · 회의 3 · 빈 시간 5시간",
    });
  });

  it("speaks English with plurals and Chinese with measure words", () => {
    expect(briefPushCopy({ urgentMail: 1, meetings: 1, freeHours: 1 }, "en")).toEqual({
      title: "Today's briefing",
      body: "1 urgent email · 1 meeting · 1 hour free",
    });
    expect(briefPushCopy({ urgentMail: 0, meetings: 4, freeHours: 6 }, "en").body).toBe(
      "0 urgent emails · 4 meetings · 6 hours free",
    );
    expect(briefPushCopy({ urgentMail: 2, meetings: 3, freeHours: 5 }, "zh")).toEqual({
      title: "今日简报",
      body: "紧急邮件2封 · 会议3场 · 空闲5小时",
    });
  });

  it("reads a retired language as English", () => {
    expect(briefPushCopy({ urgentMail: 2, meetings: 3, freeHours: 5 }, "ja").title).toBe(
      "Today's briefing",
    );
  });
});

describe("agent: a reply draft is ready", () => {
  const draft = "네, 오늘 17시 전에 최종본 보내드리겠습니다.\n\n감사합니다.";

  it("reads the board's Korean example with the quote allowed", () => {
    expect(
      agentDraftPushCopy({
        from: "Terry Smith <terry@acme.com>",
        draft,
        allowQuote: true,
        language: "ko",
      }),
    ).toEqual({
      title: "답장 초안 준비됨 · Terry Smith",
      body: "“네, 오늘 17시 전에 최종본 보내드리겠습니다.”",
    });
  });

  it("never carries draft text without the quote flag: a fixed line instead", () => {
    const off = (language: string) =>
      agentDraftPushCopy({
        from: "Terry Smith <terry@acme.com>",
        draft,
        allowQuote: false,
        language,
      });
    expect(off("ko")).toEqual({
      title: "답장 초안 준비됨 · Terry Smith",
      body: "보내기 전에 확인하세요",
    });
    expect(off("en")).toEqual({
      title: "Reply draft ready · Terry Smith",
      body: "Review it before it is sent",
    });
    expect(off("zh")).toEqual({ title: "回复草稿已就绪 · Terry Smith", body: "发送前请确认" });
    for (const language of ["en", "ko", "zh"]) expect(off(language).body).not.toContain("17시");
  });

  it("names a sender without a display name by domain, never the whole address", () => {
    const copy = agentDraftPushCopy({
      from: "terry@acme.com",
      draft: "Sure.",
      allowQuote: true,
      language: "en",
    });
    expect(copy.title).toBe("Reply draft ready · acme.com");
    expect(copy.title).not.toContain("@");
  });

  it("skips blank leading lines, folds markup, cuts a long line and closes its quote", () => {
    const long = `${"word ".repeat(60)}end`;
    const copy = agentDraftPushCopy({
      from: "Terry <t@acme.com>",
      draft: `\n  \n<p>${long}</p>`,
      allowQuote: true,
      language: "en",
    });
    expect(copy.body.startsWith("“word word")).toBe(true);
    expect(copy.body.endsWith("…”")).toBe(true);
    expect(copy.body.length).toBeLessThanOrEqual(140);
    expect(copy.body).not.toContain("<p>");
  });

  it("shows a whole address inside the draft line as its domain", () => {
    const copy = agentDraftPushCopy({
      from: "Terry <t@acme.com>",
      draft: "Hi bob@acme.com, the final deck is attached.",
      allowQuote: true,
      language: "en",
    });
    expect(copy.body).toBe("“Hi acme.com, the final deck is attached.”");
  });

  it("falls back to the fixed line when the draft is empty", () => {
    expect(
      agentDraftPushCopy({
        from: "Terry <t@acme.com>",
        draft: " \n ",
        allowQuote: true,
        language: "en",
      }).body,
    ).toBe("Review it before it is sent");
  });
});

describe("acct: the account that needs reconnecting", () => {
  it("reads the board's Korean example", () => {
    expect(
      acctPushCopy({ account: "k08200@icloud.com", label: "iCloud Mail", language: "ko" }),
    ).toEqual({
      title: "k08200@icloud.com 연결 끊김",
      body: "다시 연결하면 이 계정 메일도 분류합니다",
    });
  });

  it("speaks English and Chinese", () => {
    expect(acctPushCopy({ account: "me@gmail.com", label: "Gmail", language: "en" })).toEqual({
      title: "me@gmail.com disconnected",
      body: "Reconnect it to sort this account's mail again",
    });
    expect(acctPushCopy({ account: "me@gmail.com", label: "Gmail", language: "zh" })).toEqual({
      title: "me@gmail.com 已断开连接",
      body: "重新连接后即可继续分类此账户的邮件",
    });
  });

  it("names the provider when the address is unknown", () => {
    expect(acctPushCopy({ account: null, label: "Gmail", language: "ko" }).title).toBe(
      "Gmail 연결 끊김",
    );
    expect(acctPushCopy({ account: "  ", label: "Outlook", language: "en" }).title).toBe(
      "Outlook disconnected",
    );
  });
});
