import { describe, expect, it } from "vitest";
import type { PlaybookRecommendation } from "../agentcore/playbooks.js";
import type { InboxSummary } from "../pim/inbox-summary.js";
import { buildOperatingPlanFromSignals } from "../pim/operating-plan.js";
import type { WorkGraphSummary } from "../pim/work-graph.js";

const NOW = new Date("2026-05-11T09:00:00.000Z").getTime();

const emptyInbox: InboxSummary = {
  top3: [],
  today: { events: [], overdueTasks: [], todayTasks: [] },
};

const emptyGraph: WorkGraphSummary = {
  generatedAt: new Date(NOW).toISOString(),
  contexts: [],
};

describe("buildOperatingPlanFromSignals", () => {
  it("prioritizes pending decisions as the operating mode", () => {
    const plan = buildOperatingPlanFromSignals({
      now: NOW,
      graph: emptyGraph,
      inbox: {
        ...emptyInbox,
        top3: [
          {
            kind: "pending_action",
            id: "pa-1",
            toolName: "send_email",
            label: "send email: PartnerCo",
            conversationId: "chat-1",
            reasoning: "Approve before sending the investor reply",
            decision: {
              priority: 100,
              confidence: 0.9,
              suggestedAction: "Review and approve the draft reply",
              costOfIgnoring: "Investor follow-up slips another day.",
              evidence: [{ label: "Evidence", value: "Awaiting approval" }],
            },
          },
        ],
      },
    });

    expect(plan.mode).toBe("clear_decisions");
    expect(plan.primaryAction).toBe("send email: PartnerCo");
    expect(plan.metrics.find((metric) => metric.label === "Decisions")).toMatchObject({
      value: 1,
      tone: "critical",
    });
    expect(plan.nextMoves[0]).toMatchObject({
      href: "/chat/chat-1",
      label: "Needs approval",
      reason: "Review and approve the draft reply",
    });
    expect(plan.nextMoves[0].prompt).toContain("approval-ready decision card");
    expect(plan.nextMoves[0].prompt).toContain("/chat/chat-1");
  });

  it("turns high-risk work graph contexts into recovery moves", () => {
    const plan = buildOperatingPlanFromSignals({
      now: NOW,
      inbox: emptyInbox,
      graph: {
        generatedAt: new Date(NOW).toISOString(),
        contexts: [
          {
            id: "email:thread-1",
            kind: "email_thread",
            title: "PartnerCo renewal",
            subtitle: "Minsu",
            href: "/email/email-1",
            people: [{ name: "Minsu", email: "minsu@example.com" }],
            lastActivityAt: new Date(NOW - 60_000).toISOString(),
            risk: "high",
            reasons: ["Urgent mail", "Overdue commitment"],
            signals: {
              emails: 1,
              unreadEmails: 1,
              urgentEmails: 1,
              pendingActions: 0,
              commitments: 1,
              overdueCommitments: 1,
            },
          },
        ],
      },
    });

    expect(plan.mode).toBe("recover_risk");
    expect(plan.nextMoves[0]).toMatchObject({
      title: "PartnerCo renewal",
      label: "Risk context",
      href: "/email/email-1",
    });
    expect(plan.nextMoves[0].prompt).toContain("Work Graph");
    expect(plan.watchlist[0]).toMatchObject({
      id: "email:thread-1",
      risk: "high",
      reason: "Urgent mail",
    });
  });

  it("adds a playbook nudge when a matching recommendation exists", () => {
    const recommendation: PlaybookRecommendation = {
      playbook: {
        id: "launch_room",
        domain: "launch",
        name: "Launch Room",
        description: "Coordinate launch work",
        bestFor: "launches",
        cadence: "Daily",
        targetSignals: ["launch"],
        activationChecklist: [],
        active: true,
      },
      score: 35,
      confidence: 0.7,
      reasons: ["High-risk matching context"],
      activeContexts: [],
      suggestedFirstActions: [
        {
          id: "launch-blockers",
          title: "Find launch blockers",
          description: "Surface approvals and overdue promises.",
        },
      ],
    };

    const plan = buildOperatingPlanFromSignals({
      now: NOW,
      inbox: emptyInbox,
      graph: emptyGraph,
      recommendations: [recommendation],
    });

    expect(plan.playbookNudge).toMatchObject({
      id: "launch_room",
      active: true,
      nextStep: "Find launch blockers",
    });
    expect(plan.nextMoves[0]).toMatchObject({
      source: "playbook",
      label: "Active playbook",
    });
  });

  it("carries recent decision outcomes as a loop pulse", () => {
    const plan = buildOperatingPlanFromSignals({
      now: NOW,
      inbox: emptyInbox,
      graph: emptyGraph,
      decisionPulse: {
        windowHours: 24,
        executed: 2,
        rejected: 1,
        failed: 0,
        latest: [
          {
            id: "pa-2",
            title: "투자자 답장 발송",
            status: "executed",
            toolName: "send_email",
            href: "/chat/chat-2",
            decidedAt: new Date(NOW - 60_000).toISOString(),
            result: "sent",
          },
        ],
      },
    });

    expect(plan.decisionPulse).toMatchObject({
      windowHours: 24,
      executed: 2,
      rejected: 1,
      failed: 0,
    });
    expect(plan.decisionPulse.latest[0]).toMatchObject({
      title: "투자자 답장 발송",
      status: "executed",
      href: "/chat/chat-2",
    });
  });
});
