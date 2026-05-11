import { describe, expect, it } from "vitest";
import {
  extractFeedbackPolicyCandidates,
  type FeedbackPolicyCandidateKind,
  formatFeedbackPolicyCandidatesForPrompt,
} from "../policy-extraction.js";

type FeedbackPolicyEvent = Parameters<typeof extractFeedbackPolicyCandidates>[0][number];

function event(over: Partial<FeedbackPolicyEvent> = {}): FeedbackPolicyEvent {
  return {
    id: over.id ?? "f-1",
    signal: over.signal ?? "APPROVED",
    toolName: over.toolName ?? "send_email",
    recipient: over.recipient ?? null,
    threadId: over.threadId ?? null,
    evidence: over.evidence ?? null,
    createdAt: over.createdAt ?? new Date("2026-04-28T00:00:00.000Z"),
  };
}

function kinds(
  candidates: ReturnType<typeof extractFeedbackPolicyCandidates>,
): FeedbackPolicyCandidateKind[] {
  return candidates.map((candidate) => candidate.kind);
}

describe("extractFeedbackPolicyCandidates", () => {
  it("returns no candidates below the evidence threshold", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", signal: "APPROVED" }),
      event({ id: "b", signal: "APPROVED" }),
    ]);
    expect(out).toEqual([]);
  });

  it("extracts a recipient-specific allow candidate from repeated approvals", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", recipient: "Sarah@Example.com" }),
      event({ id: "b", recipient: "sarah@example.com" }),
      event({ id: "c", recipient: " sarah@example.com " }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "ALLOW_AFTER_SUGGESTION",
      scope: {
        type: "RECIPIENT_TOOL",
        toolName: "send_email",
        recipient: "sarah@example.com",
      },
      active: false,
    });
    expect(out[0].support.approved).toBe(3);
  });

  it("does not turn one recipient's approvals into a broad tool policy", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", recipient: "sarah@example.com" }),
      event({ id: "b", recipient: "sarah@example.com" }),
      event({ id: "c", recipient: "sarah@example.com" }),
    ]);

    expect(out.map((candidate) => candidate.scope.type)).toEqual(["RECIPIENT_TOOL"]);
  });

  it("does not extract allow candidates when approvals are mixed with too much quiet negative signal", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", signal: "APPROVED", toolName: "notify_user" }),
      event({ id: "b", signal: "APPROVED", toolName: "notify_user" }),
      event({ id: "c", signal: "APPROVED", toolName: "notify_user" }),
      event({ id: "d", signal: "IGNORED", toolName: "notify_user" }),
      event({ id: "e", signal: "SNOOZED", toolName: "notify_user" }),
    ]);

    expect(out).toEqual([]);
  });

  it("extracts a tool-level allow candidate across multiple recipients", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", recipient: "sarah@example.com" }),
      event({ id: "b", recipient: "alex@example.com" }),
      event({ id: "c", recipient: "alex@example.com" }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "ALLOW_AFTER_SUGGESTION",
      scope: { type: "TOOL", toolName: "send_email", recipient: null },
    });
    expect(out[0].support.distinctRecipients).toBe(2);
  });

  it("extracts avoid candidates from repeated explicit negative signals", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", signal: "REJECTED", toolName: "schedule_meeting" }),
      event({ id: "b", signal: "DISMISSED", toolName: "schedule_meeting" }),
      event({ id: "c", signal: "FAILED", toolName: "schedule_meeting" }),
    ]);

    expect(kinds(out)).toEqual(["AVOID_SUGGESTION"]);
    expect(out[0].support.rejected).toBe(1);
    expect(out[0].support.failed).toBe(1);
    expect(out[0].support.dismissed).toBe(1);
  });

  it("extracts draft-review candidates when edits dominate", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", signal: "EDITED", toolName: "draft_reply" }),
      event({ id: "b", signal: "EDITED", toolName: "draft_reply" }),
      event({ id: "c", signal: "APPROVED", toolName: "draft_reply" }),
    ]);

    expect(kinds(out)).toEqual(["REQUIRE_DRAFT_REVIEW"]);
  });

  it("extracts lower-priority candidates from repeated quiet negative signals", () => {
    const out = extractFeedbackPolicyCandidates([
      event({ id: "a", signal: "IGNORED", toolName: "notify_user" }),
      event({ id: "b", signal: "SNOOZED", toolName: "notify_user" }),
      event({ id: "c", signal: "IGNORED", toolName: "notify_user" }),
    ]);

    expect(kinds(out)).toEqual(["LOWER_PRIORITY"]);
  });

  it("formats candidates as soft prompt policy, not authorization", () => {
    const candidates = extractFeedbackPolicyCandidates([
      event({ id: "a", recipient: "sarah@example.com" }),
      event({ id: "b", recipient: "sarah@example.com" }),
      event({ id: "c", recipient: "sarah@example.com" }),
    ]);

    const prompt = formatFeedbackPolicyCandidatesForPrompt(candidates);
    expect(prompt).toContain("Learned Feedback Policy Signals");
    expect(prompt).toContain("tool send_email for sarah@example.com");
    expect(prompt).toContain("NOT authorization");
    expect(prompt).toContain("approval gates");
  });

  it("omits prompt context when there are no confident candidates", () => {
    expect(formatFeedbackPolicyCandidatesForPrompt([])).toBe("");
    const candidates = extractFeedbackPolicyCandidates(
      [
        event({ id: "a", signal: "REJECTED", toolName: "send_email" }),
        event({ id: "b", signal: "DISMISSED", toolName: "send_email" }),
      ],
      { minEvents: 2 },
    );
    expect(formatFeedbackPolicyCandidatesForPrompt(candidates, { minConfidence: 0.96 })).toBe("");
  });
});
