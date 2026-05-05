import { describe, expect, it } from "vitest";
import {
  areSimilarProposalIssues,
  getNotifKey,
  getToolRisk,
  isHousekeepingProposalToolName,
  proposalIssueTokens,
  TOOL_RISK_LEVELS,
} from "../agent-logic.js";

describe("getToolRisk", () => {
  it("returns LOW for safe, reversible tools", () => {
    expect(getToolRisk("create_reminder")).toBe("LOW");
    expect(getToolRisk("create_task")).toBe("LOW");
    expect(getToolRisk("update_task")).toBe("LOW");
    expect(getToolRisk("classify_emails")).toBe("LOW");
    expect(getToolRisk("mark_read")).toBe("LOW");
    expect(getToolRisk("execute_skill")).toBe("LOW");
  });

  it("returns MEDIUM for external-facing tools that need approval", () => {
    expect(getToolRisk("send_email")).toBe("MEDIUM");
    expect(getToolRisk("create_event")).toBe("MEDIUM");
    expect(getToolRisk("create_contact")).toBe("MEDIUM");
  });

  it("returns HIGH for destructive tools", () => {
    expect(getToolRisk("delete_task")).toBe("HIGH");
    expect(getToolRisk("delete_reminder")).toBe("HIGH");
    expect(getToolRisk("delete_event")).toBe("HIGH");
    expect(getToolRisk("delete_email")).toBe("HIGH");
    expect(getToolRisk("archive_email")).toBe("HIGH");
  });

  it("returns undefined for unknown tools (read-only or unclassified)", () => {
    expect(getToolRisk("list_tasks")).toBeUndefined();
    expect(getToolRisk("web_search")).toBeUndefined();
    expect(getToolRisk("nonexistent_tool")).toBeUndefined();
  });

  it("every classified delete-style tool is HIGH — guard against accidental downgrades", () => {
    // Any tool whose name starts with "delete_" must be HIGH or unclassified.
    // A LOW/MEDIUM delete_* would let the agent wipe user data without confirmation.
    for (const [name, risk] of TOOL_RISK_LEVELS) {
      if (name.startsWith("delete_")) {
        expect(risk, `${name} must be HIGH`).toBe("HIGH");
      }
    }
  });

  it("send_email and external tools are not downgraded to LOW", () => {
    expect(getToolRisk("send_email")).not.toBe("LOW");
  });
});

describe("getNotifKey", () => {
  it("lowercases input", () => {
    expect(getNotifKey("Meeting Alert")).toBe("meetingalert");
  });

  it("strips whitespace", () => {
    expect(getNotifKey("a b  c\td\ne")).toBe("abcde");
  });

  it("strips common punctuation", () => {
    expect(getNotifKey("!alert, please.")).toBe("alertplease");
    expect(getNotifKey("(group) - [note] 'x'\"y\"")).toBe("groupnotexy");
    expect(getNotifKey("·dot·middot")).toBe("dotmiddot");
  });

  it("truncates to 30 characters after stripping", () => {
    const long = "a".repeat(50);
    const key = getNotifKey(long);
    expect(key).toHaveLength(30);
    expect(key).toBe("a".repeat(30));
  });

  it("collapses two near-duplicate notification titles to the same key", () => {
    // The motivating case documented in the source comment.
    const a = getNotifKey("스크럼 장소 확인");
    const b = getNotifKey("스크럼 장소, 확인");
    expect(a).toBe(b);
  });

  it("does not collapse genuinely different titles", () => {
    expect(getNotifKey("Call John")).not.toBe(getNotifKey("Email John"));
  });

  it("returns empty string for input that is entirely stripped", () => {
    expect(getNotifKey("")).toBe("");
    expect(getNotifKey("   ")).toBe("");
    expect(getNotifKey("!!!...")).toBe("");
  });
});

describe("proposal issue dedup", () => {
  it("extracts stable anchors from proposal text and tool args", () => {
    const tokens = proposalIssueTokens({
      message:
        "📋 상황: 캘린더에 '🎯 Impact Giving 신청 마감(5/10) PM 8:00'이 있고 리마인더가 많아요.",
      toolName: "cleanup_reminders",
      toolArgs: { title: "Impact Giving 신청 마감", due: "2026-05-10T20:00:00+09:00" },
    });

    expect(tokens.has("impact")).toBe(true);
    expect(tokens.has("giving")).toBe(true);
    expect(tokens.has("신청")).toBe(true);
    expect(tokens.has("마감")).toBe(true);
  });

  it("collapses repeated Impact Giving proposals even when the action shape changes", () => {
    const first = {
      message:
        "📋 상황: 캘린더에는 '🎯 Impact Giving 신청 마감(5/10) PM 8:00'이 있고, 5/10 AM 9:00·PM 5:00·PM 8:00까지 마감 관련 알림이 다수 잡혀 있어요. ✅ 제안: 오늘 19:05~19:20에 신청 폼 작성 시간 블록을 추가해드릴까요?",
      toolName: "create_calendar_time_block_and_optional_reminder",
      toolArgs: { title: "Impact Giving 신청 폼 작성", date: "2026-05-05", deadline: "2026-05-10" },
    };
    const second = {
      message:
        "📋 상황: 'Impact Giving 신청' 관련 알림이 5/5~5/10에 여러 개 잡혀 있고, 캘린더에는 5/10 PM 8:00 마감이 있어요. ✅ 제안: 오늘 오후 6시 'Impact Giving 신청서 작성 1회차' 태스크를 새로 만들까요?",
      toolName: "create_task_and_optional_reminder_single_highlight",
      toolArgs: { title: "Impact Giving 신청서 작성", dueDate: "2026-05-10" },
    };

    expect(areSimilarProposalIssues(first, second)).toBe(true);
  });

  it("does not collapse unrelated proposals that only share generic workflow terms", () => {
    const first = {
      message:
        "📋 상황: Impact Giving 신청 마감이 5/10 PM 8:00이에요. ✅ 제안: 제출 전 체크리스트를 만들까요?",
      toolName: "create_task",
      toolArgs: { title: "Impact Giving 제출 체크" },
    };
    const second = {
      message:
        "📋 상황: Vercel 보안 업데이트 메일 확인이 필요해요. ✅ 제안: 보안 업데이트 확인 태스크를 만들까요?",
      toolName: "create_task",
      toolArgs: { title: "Vercel Security Update 확인" },
    };

    expect(areSimilarProposalIssues(first, second)).toBe(false);
  });
});

describe("isHousekeepingProposalToolName", () => {
  it("blocks proactive cleanup and reorganize proposal names", () => {
    expect(isHousekeepingProposalToolName("cleanup_reminders_to_critical_only")).toBe(true);
    expect(isHousekeepingProposalToolName("cleanup calendar item misdated")).toBe(true);
    expect(isHousekeepingProposalToolName("reorganize_calendar_items")).toBe(true);
    expect(isHousekeepingProposalToolName("update_reminders")).toBe(true);
    expect(isHousekeepingProposalToolName("dedupe_reminders")).toBe(true);
  });

  it("allows concrete executable tools", () => {
    expect(isHousekeepingProposalToolName("create_task")).toBe(false);
    expect(isHousekeepingProposalToolName("create_event")).toBe(false);
    expect(isHousekeepingProposalToolName("create_reminder")).toBe(false);
    expect(isHousekeepingProposalToolName("update_task")).toBe(false);
  });
});
