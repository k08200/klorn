/**
 * Assistant hub (productization plan P7, UNIFIED_HOME) — the pure rules behind
 * packages/web/src/app/assistant: which hub route a legacy route maps to (and
 * back, with the flag off), what an approval card says about a pending action,
 * how the day's receipt becomes one activity timeline, and the approval keys.
 * Run from the api suite because the web package has no unit-test runner.
 */

import type { DailyReceipt, ReceiptItem } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import {
  activityEntries,
  activityReasonKey,
  activityTitle,
  dayPartOf,
  groupByDayPart,
} from "../../../web/src/app/assistant/activity/model";
import {
  approvalModel,
  nextSelection,
  type PendingActionItem,
  splitReasoning,
} from "../../../web/src/app/assistant/approvals/model";
import {
  ASSISTANT_ACTIVITY,
  ASSISTANT_APPROVALS,
  ASSISTANT_BRIEFING,
  ASSISTANT_CHAT,
  ASSISTANT_ROUTES,
  assistantHref,
  hubRouteFor,
  legacyRouteFor,
} from "../../../web/src/lib/home";
import {
  createHotkeyMatcher,
  HOTKEYS,
  type HotkeyContext,
  type HotkeyScope,
  type KeyEventLike,
} from "../../../web/src/lib/hotkeys";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";

const action = (over: Partial<PendingActionItem>): PendingActionItem => ({
  id: "a1",
  conversationId: "c1",
  conversationTitle: null,
  status: "PENDING",
  toolName: "send_email",
  toolArgs: "{}",
  targetLabel: null,
  reasoning: null,
  result: null,
  createdAt: "2026-10-08T09:00:00.000Z",
  ...over,
});

describe("hub routes", () => {
  it("Assistant leads to the approvals page of the hub", () => {
    expect(assistantHref()).toBe("/assistant/approvals");
    expect(ASSISTANT_ROUTES).toContain("/assistant");
  });

  it("maps the three legacy routes to their hub page, keeping the query", () => {
    expect(hubRouteFor("/inbox", "")).toBe(ASSISTANT_APPROVALS);
    expect(hubRouteFor("/inbox", "?view=firewall&x=1")).toBe(
      "/assistant/approvals?view=firewall&x=1",
    );
    expect(hubRouteFor("/briefing", "?from=push")).toBe("/assistant/briefing?from=push");
    expect(hubRouteFor("/inbox/receipt", "")).toBe(ASSISTANT_ACTIVITY);
    expect(hubRouteFor("/inbox/", "")).toBe(ASSISTANT_APPROVALS);
  });

  it("leaves every other route alone, including inherited object keys", () => {
    for (const path of ["/inbox/firewall", "/chat", "/email", "/", "constructor", "__proto__"]) {
      expect(hubRouteFor(path, ""), path).toBeNull();
    }
  });

  it("never builds a destination from the request: the target is one of four constants", () => {
    const hostile = hubRouteFor("/inbox", "?next=//evil.example");
    expect(hostile?.startsWith("/assistant/approvals?")).toBe(true);
    // A search string without its leading "?" is not appended as a path.
    expect(hubRouteFor("/inbox", "//evil.example")).toBe(ASSISTANT_APPROVALS);
  });

  it("with the flag off every hub page hands back to its legacy route", () => {
    expect(legacyRouteFor("/assistant", "")).toBe("/inbox");
    expect(legacyRouteFor(ASSISTANT_APPROVALS, "?a=1")).toBe("/inbox?a=1");
    expect(legacyRouteFor(ASSISTANT_BRIEFING, "")).toBe("/briefing");
    expect(legacyRouteFor(ASSISTANT_ACTIVITY, "")).toBe("/inbox/receipt");
    expect(legacyRouteFor(ASSISTANT_CHAT, "")).toBe("/chat");
    expect(legacyRouteFor("/assistant/unknown", "")).toBe("/inbox");
    expect(legacyRouteFor("/assistant/toString", "")).toBe("/inbox");
  });
});

describe("approvalModel", () => {
  it("a send: human title, recipient and subject, the full draft, and it sends mail", () => {
    const model = approvalModel(
      action({
        toolArgs: JSON.stringify({
          to: "mina@example.com",
          subject: "Re: Contract renewal",
          body: "Hi Mina,\n\nSigned copy attached.",
        }),
        reasoning:
          "📋 Situation: Mina asked for the signed copy.\n💡 Judgment: She needs it by Friday.",
      }),
    );
    expect(model.titleKey).toBe("tool.label.send_email");
    expect(model.sendsMail).toBe(true);
    expect(model.subject).toBe("Re: Contract renewal");
    expect(model.facts).toEqual([
      { labelKey: "assistantHub.approvals.fact.to", text: "mina@example.com" },
    ]);
    expect(model.preview).toBe("Hi Mina,\n\nSigned copy attached.");
    expect(model.why).toBe("She needs it by Friday.");
  });

  it("accepts tool arguments as an object as well as a JSON string", () => {
    const model = approvalModel(
      action({ toolArgs: { to: "a@example.com", subject: "Hello", body: "Body" } }),
    );
    expect(model.subject).toBe("Hello");
    expect(model.preview).toBe("Body");
  });

  it("a calendar event: title, when and where; it does not send mail", () => {
    const model = approvalModel(
      action({
        toolName: "create_event",
        toolArgs: JSON.stringify({
          summary: "Design review",
          start_time: "2026-10-09T05:00:00.000Z",
          location: "Room 4",
          description: "Walk through the new hub.",
        }),
      }),
    );
    expect(model.titleKey).toBe("tool.label.create_event");
    expect(model.sendsMail).toBe(false);
    expect(model.subject).toBe("Design review");
    expect(model.facts).toEqual([
      { labelKey: "assistantHub.approvals.fact.when", iso: "2026-10-09T05:00:00.000Z" },
      { labelKey: "assistantHub.approvals.fact.where", text: "Room 4" },
    ]);
    expect(model.preview).toBe("Walk through the new hub.");
  });

  it("an archive names the thing it acts on from the resolved target, never an id", () => {
    const model = approvalModel(
      action({
        toolName: "archive_email",
        toolArgs: JSON.stringify({ email_id: "0b1f-uuid" }),
        targetLabel: "Your October invoice",
        conversationTitle: "Billing",
      }),
    );
    expect(model.titleKey).toBe("tool.label.archive_email");
    expect(model.subject).toBe("Your October invoice");
    expect(JSON.stringify(model)).not.toContain("0b1f-uuid");
  });

  it("falls back to the conversation title, then to nothing", () => {
    expect(
      approvalModel(action({ toolName: "mark_read", conversationTitle: "Weekly digest" })).subject,
    ).toBe("Weekly digest");
    expect(approvalModel(action({ toolName: "mark_read" })).subject).toBeNull();
  });

  it("an unknown tool gets the generic label, never its raw id", () => {
    const model = approvalModel(action({ toolName: "frobnicate_widget", toolArgs: "{}" }));
    expect(model.titleKey).toBe("tool.label.unknown");
    expect(JSON.stringify(model)).not.toContain("frobnicate");
  });

  it("an undo proposal is named after the action it reverses", () => {
    const model = approvalModel(action({ toolName: "undo_archive_email" }));
    expect(model.undo).toBe(true);
    expect(model.titleKey).toBe("tool.label.archive_email");
    expect(approvalModel(action({ toolName: "undo_frobnicate" })).titleKey).toBe(
      "tool.label.unknown",
    );
  });

  it("malformed arguments degrade to the title alone", () => {
    const model = approvalModel(action({ toolArgs: "{not json" }));
    expect(model.subject).toBeNull();
    expect(model.facts).toEqual([]);
    expect(model.preview).toBeNull();
  });

  it("splitReasoning prefers the judgment and accepts plain text", () => {
    expect(splitReasoning("Just do it")).toBe("Just do it");
    expect(splitReasoning("Situation: A.\nProposal: C.")).toBe("A.");
    expect(splitReasoning(null)).toBeNull();
    expect(splitReasoning("   ")).toBeNull();
  });
});

describe("nextSelection", () => {
  const ids = ["a", "b", "c"];
  it("starts at the first card going down and the last going up", () => {
    expect(nextSelection(ids, null, 1)).toBe("a");
    expect(nextSelection(ids, null, -1)).toBe("c");
  });
  it("stops at the ends instead of wrapping", () => {
    expect(nextSelection(ids, "c", 1)).toBe("c");
    expect(nextSelection(ids, "a", -1)).toBe("a");
    expect(nextSelection(ids, "a", 1)).toBe("b");
  });
  it("recovers when the selected card has left the list", () => {
    expect(nextSelection(ids, "gone", 1)).toBe("a");
    expect(nextSelection([], "a", 1)).toBeNull();
  });
});

const item = (over: Partial<ReceiptItem>): ReceiptItem => ({
  id: "r1",
  title: "Invoice from Acme",
  source: "EMAIL",
  type: "REPLY_NEEDED",
  tierReason: null,
  surfacedAt: "2026-10-08T01:00:00.000Z",
  ...over,
});

const receipt = (over: Partial<DailyReceipt>): DailyReceipt => ({
  date: "2026-10-08",
  silenced: [],
  queued: [],
  pushed: [],
  auto: [],
  summary: { totalSeen: 0, totalInterrupted: 0, savedFromInbox: 0, autoHandled: 0, narrative: "" },
  ...over,
});

describe("activity", () => {
  it("merges the four receipt lists into one timeline, newest first", () => {
    const entries = activityEntries(
      receipt({
        auto: [item({ id: "h", surfacedAt: "2026-10-08T03:00:00.000Z" })],
        pushed: [item({ id: "n", surfacedAt: "2026-10-08T05:00:00.000Z" })],
        queued: [item({ id: "q", surfacedAt: "2026-10-08T01:00:00.000Z" })],
        silenced: [item({ id: "s", surfacedAt: "2026-10-08T04:00:00.000Z" })],
      }),
    );
    expect(entries.map((e) => `${e.kind}:${e.item.id}`)).toEqual([
      "notified:n",
      "silenced:s",
      "handled:h",
      "queued:q",
    ]);
  });

  it("keys stay unique when two lists carry the same id", () => {
    const entries = activityEntries(
      receipt({ auto: [item({ id: "x" })], queued: [item({ id: "x" })] }),
    );
    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
  });

  it("buckets by the hour in the user's zone", () => {
    // 01:00Z is 10:00 in Seoul and 21:00 the previous day in New York.
    expect(dayPartOf("2026-10-08T01:00:00.000Z", "Asia/Seoul")).toBe("morning");
    expect(dayPartOf("2026-10-08T01:00:00.000Z", "America/New_York")).toBe("evening");
    expect(dayPartOf("2026-10-08T05:00:00.000Z", "Asia/Seoul")).toBe("afternoon");
    expect(dayPartOf("2026-10-08T17:00:00.000Z", "Asia/Seoul")).toBe("night");
    expect(dayPartOf("not a date", "Asia/Seoul")).toBe("morning");
    expect(dayPartOf("2026-10-08T01:00:00.000Z", "Not/AZone")).toBe("morning");
  });

  it("groups in the order the entries arrive, one group per part of the day", () => {
    const entries = activityEntries(
      receipt({
        queued: [
          item({ id: "1", surfacedAt: "2026-10-08T09:30:00.000Z" }),
          item({ id: "2", surfacedAt: "2026-10-08T05:00:00.000Z" }),
          item({ id: "3", surfacedAt: "2026-10-08T04:00:00.000Z" }),
        ],
      }),
    );
    const groups = groupByDayPart(entries, "Asia/Seoul");
    expect(groups.map((g) => [g.part, g.entries.length])).toEqual([
      ["evening", 1],
      ["afternoon", 2],
    ]);
  });

  it("an executed action titled with its raw tool id gets the human label instead", () => {
    expect(activityTitle(item({ source: "PENDING_ACTION", title: "archive email" }))).toEqual({
      labelKey: "tool.label.archive_email",
    });
    expect(activityTitle(item({ source: "PENDING_ACTION", title: "frobnicate widget" }))).toEqual({
      text: "frobnicate widget",
    });
    expect(activityTitle(item({ source: "PENDING_ACTION", title: "constructor" }))).toEqual({
      text: "constructor",
    });
    expect(activityTitle(item({ title: "Email signal (DRAFT_REPLY)" }))).toEqual({
      labelKey: "assistantHub.activity.observedTitle",
    });
    expect(activityTitle(item({ title: "Invoice from Acme" }))).toEqual({
      text: "Invoice from Acme",
    });
  });

  it("the two fixed server reasons are translated; a judged reason is shown as written", () => {
    expect(activityReasonKey("Auto-executed — low risk, pre-approved")).toBe(
      "assistantHub.activity.reason.executed",
    );
    expect(activityReasonKey("Observed in SHADOW mode — not surfaced yet")).toBe(
      "assistantHub.activity.reason.observed",
    );
    expect(activityReasonKey("Sender is your manager")).toBeNull();
    expect(activityReasonKey("toString")).toBeNull();
    expect(activityReasonKey(null)).toBeNull();
  });
});

describe("approval keys", () => {
  const key = (k: string): KeyEventLike => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });
  const ctx = (triage: boolean, ...scopes: HotkeyScope[]): HotkeyContext => ({
    triage,
    scopes: new Set<HotkeyScope>(["global", ...scopes]),
    unifiedHome: true,
  });
  const press = (k: string, c: HotkeyContext) => {
    const match = createHotkeyMatcher().feed(key(k), { tagName: "BODY" }, (d) => d.enabled(c), 0);
    return match.kind === "match" ? match.def.id : match.kind;
  };

  it("j / k move, a approves, x rejects, o opens the preview — on the approvals page only", () => {
    const on = ctx(true, "approvals");
    expect(press("j", on)).toBe("approvals.next");
    expect(press("k", on)).toBe("approvals.prev");
    expect(press("a", on)).toBe("approvals.approve");
    expect(press("x", on)).toBe("approvals.reject");
    expect(press("o", on)).toBe("approvals.expand");
    expect(press("a", ctx(true))).toBe("none");
    expect(press("a", ctx(true, "mail-list"))).toBe("none");
  });

  it("none of them exist without keyboard triage", () => {
    const off = ctx(false, "approvals");
    for (const k of ["j", "k", "a", "x", "o"]) expect(press(k, off)).toBe("none");
  });

  it("g then a still goes to Assistant from the approvals page", () => {
    const on = ctx(true, "approvals");
    const matcher = createHotkeyMatcher();
    matcher.feed(key("g"), { tagName: "BODY" }, (d) => d.enabled(on), 0);
    const second = matcher.feed(key("a"), { tagName: "BODY" }, (d) => d.enabled(on), 10);
    expect(second.kind === "match" && second.def.id).toBe("go.assistant");
  });

  it("only movement repeats on a held key: a held A never approves twice", () => {
    const approve = HOTKEYS.find((d) => d.id === "approvals.approve");
    const reject = HOTKEYS.find((d) => d.id === "approvals.reject");
    expect(approve?.repeatable).toBeUndefined();
    expect(reject?.repeatable).toBeUndefined();
    expect(HOTKEYS.find((d) => d.id === "approvals.next")?.repeatable).toBe(true);
  });

  it("every approval key has a label in all seven locales", () => {
    const tables = { en, ko, ja, zh, es, fr, de };
    const defs = HOTKEYS.filter((d) => d.id.startsWith("approvals."));
    expect(defs).toHaveLength(5);
    for (const def of defs) {
      for (const [locale, table] of Object.entries(tables)) {
        expect(table[def.labelKey], `${locale} ${def.labelKey}`).toBeTruthy();
      }
    }
  });
});
