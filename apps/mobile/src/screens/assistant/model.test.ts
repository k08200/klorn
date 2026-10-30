import { describe, expect, it } from "vitest";
import { mockPendingActions } from "../../api/mock/fixtures";
import { mockReceipt } from "../../api/mock/fixtures-hub";
import type { PendingActionWire } from "../../api/wire";
import { createTranslator } from "../../i18n";
import { en } from "../../i18n/locales/en";
import { ko } from "../../i18n/locales/ko";
import {
  activityEntries,
  activityReason,
  activityTitle,
  approvalModel,
  chatCapNotice,
  dayPartOf,
  groupByDayPart,
  splitReasoning,
  visibleMessages,
} from "./model";

const NOW = Date.parse("2026-10-16T10:28:00+09:00");

function action(over: Partial<PendingActionWire>): PendingActionWire {
  return {
    id: "a",
    conversationId: "c",
    conversationTitle: null,
    status: "PENDING",
    toolName: "send_email",
    toolArgs: {},
    targetLabel: null,
    reasoning: null,
    result: null,
    createdAt: new Date(NOW).toISOString(),
    ...over,
  };
}

describe("approval cards say exactly what will happen", () => {
  const [reply, meeting, task] = mockPendingActions(NOW).map(approvalModel);

  it("a send shows recipient, subject and the body, and is flagged irreversible", () => {
    expect(reply?.titleKey).toBe("assistant.tool.send_email");
    expect(reply?.sendsMail).toBe(true);
    expect(reply?.kind).toBe("email");
    expect(reply?.subject).toBe("Re: 계약서 수정본 — 오늘 서명 가능할까요?");
    expect(reply?.facts).toEqual([
      { labelKey: "assistant.fact.to", text: "seoyeon@hanbitpartners.example" },
    ]);
    expect(reply?.preview).toContain("오후 4시 전에 서명");
  });

  it("an event shows when and where", () => {
    expect(meeting?.kind).toBe("calendar");
    expect(meeting?.sendsMail).toBe(false);
    expect(meeting?.facts.map((f) => f.labelKey)).toEqual([
      "assistant.fact.when",
      "assistant.fact.where",
    ]);
    expect(task?.subject).toBe("계약서 서명");
  });

  it("an unknown tool lists its plain arguments (ids included), never JSON", () => {
    const model = approvalModel(
      action({
        toolName: "rename_folder",
        toolArgs: JSON.stringify({ folder_id: "f1", newName: "Q4", nested: { a: 1 } }),
      }),
    );
    expect(model.titleKey).toBe("assistant.tool.unknown");
    expect(model.facts).toEqual([
      { label: "Folder id", text: "f1" },
      { label: "New name", text: "Q4" },
    ]);
    const known = approvalModel(
      action({ toolName: "delete_task", toolArgs: { task_id: "t1", reason: "done" } }),
    );
    expect(known.facts).toEqual([{ label: "Reason", text: "done" }]);
  });

  it("an undo is never a send; malformed args are empty", () => {
    const undo = approvalModel(action({ toolName: "undo_send_email", toolArgs: "{not json" }));
    expect(undo.undo).toBe(true);
    expect(undo.sendsMail).toBe(false);
    expect(undo.facts).toEqual([]);
  });

  it("keeps the judgment as the reason", () => {
    expect(splitReasoning("📋 Situation: a\n💡 Judgment: b\n✅ Proposal: c")).toBe("b");
    expect(splitReasoning("Situation: only this")).toBe("only this");
    expect(splitReasoning("  ")).toBeNull();
  });
});

describe("activity", () => {
  const receipt = mockReceipt(NOW);
  const entries = activityEntries(receipt);

  it("merges the four lists newest first", () => {
    expect(entries).toHaveLength(6);
    expect(entries[0]?.kind).toBe("handled");
    expect(entries.at(-1)?.kind).toBe("silenced");
  });

  it("groups by part of the day in the user's zone", () => {
    expect(dayPartOf("2026-10-16T01:12:00+09:00", "Asia/Seoul")).toBe("night");
    expect(dayPartOf("2026-10-16T13:00:00+09:00", "Asia/Seoul")).toBe("afternoon");
    expect(dayPartOf("bad", "Asia/Seoul")).toBe("morning");
    expect(groupByDayPart(entries, "Asia/Seoul").map((g) => g.part)).toEqual(["morning", "night"]);
  });

  it("names tool rows and translates the server's fixed reasons only", () => {
    const auto = entries.find((e) => e.kind === "handled");
    expect(auto && activityTitle(auto.item)).toEqual({ key: "assistant.tool.create_task" });
    expect(activityReason("Auto-executed — low risk, pre-approved")).toEqual({
      key: "assistant.activity.reason.executed",
    });
    expect(activityReason("광고")).toEqual({ text: "광고" });
  });

  it("hides system messages from the thread", () => {
    const at = new Date(NOW).toISOString();
    expect(
      visibleMessages([
        { id: "1", role: "SYSTEM", content: "x", metadata: null, createdAt: at },
        { id: "2", role: "USER", content: "hi", metadata: null, createdAt: at },
        { id: "3", role: "ASSISTANT", content: " ", metadata: null, createdAt: at },
      ]).map((m) => m.id),
    ).toEqual(["2"]);
  });
});

describe("chatCapNotice (the daily AI allowance reached)", () => {
  it("offers plans to a FREE user at the cap", () => {
    expect(chatCapNotice("DAILY_COST_CAP_FREE")).toEqual({
      key: "assistant.chat.capFree",
      plans: true,
    });
  });

  it("names the cap without a plans link for everyone else", () => {
    expect(chatCapNotice("DAILY_COST_CAP")).toEqual({ key: "assistant.chat.cap", plans: false });
  });

  it("is absent for an old server, no error, or an unknown code (current behaviour)", () => {
    expect(chatCapNotice(undefined)).toBeNull();
    expect(chatCapNotice(null)).toBeNull();
    expect(chatCapNotice("")).toBeNull();
    expect(chatCapNotice("SOMETHING_NEW")).toBeNull();
  });

  it("reads in the app's language, not the server's English", () => {
    const free = chatCapNotice("DAILY_COST_CAP_FREE");
    if (!free) throw new Error("expected a notice");
    expect(createTranslator("en", en).t(free.key)).toBe(
      "You've used today's free AI allowance. It resets at 00:00 UTC.",
    );
    expect(createTranslator("ko", ko).t(free.key)).toBe(
      "오늘 쓸 수 있는 무료 AI 사용량을 다 썼어요. UTC 00:00에 초기화돼요.",
    );
  });
});
