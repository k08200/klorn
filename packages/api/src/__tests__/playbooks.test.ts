import { describe, expect, it } from "vitest";
import { listKlornPlaybooks, recommendPlaybooksFromGraph } from "../playbooks.js";
import type { WorkGraphContext, WorkGraphSummary } from "../work-graph.js";

function context(over: Partial<WorkGraphContext> = {}): WorkGraphContext {
  return {
    id: over.id ?? "email:thread-1",
    kind: over.kind ?? "email_thread",
    title: over.title ?? "Series A investor update",
    subtitle: over.subtitle ?? "Investor relations",
    href: over.href ?? "/email/email-1",
    people: over.people ?? [],
    lastActivityAt: over.lastActivityAt ?? "2026-04-28T00:00:00.000Z",
    risk: over.risk ?? "high",
    reasons: over.reasons ?? ["읽지 않은 메일", "지난 약속"],
    signals: over.signals ?? {
      emails: 2,
      unreadEmails: 1,
      urgentEmails: 1,
      pendingActions: 1,
      commitments: 1,
      overdueCommitments: 1,
    },
  };
}

function graph(contexts: WorkGraphContext[]): WorkGraphSummary {
  return { generatedAt: "2026-04-28T00:00:00.000Z", contexts };
}

describe("Eve playbooks", () => {
  it("exposes the canonical built-in playbooks", () => {
    expect(listKlornPlaybooks().map((playbook) => playbook.domain)).toEqual([
      "investment",
      "customer_success",
      "launch",
      "hiring",
    ]);
  });

  it("recommends the investment playbook for investor work graph signals", () => {
    const summary = recommendPlaybooksFromGraph(graph([context()]));

    expect(summary.recommendations[0]).toMatchObject({
      playbook: { id: "investment_ops" },
    });
    expect(summary.recommendations[0].score).toBeGreaterThan(20);
    expect(summary.recommendations[0].activeContexts[0]).toMatchObject({
      title: "Series A investor update",
      risk: "high",
    });
  });

  it("limits recommendations and keeps unrelated playbooks out", () => {
    const summary = recommendPlaybooksFromGraph(
      graph([
        context({
          title: "Candidate interview loop",
          subtitle: "Recruiter coordination",
          reasons: ["승인 대기: send email"],
        }),
        context({
          id: "email:thread-2",
          title: "Customer renewal escalation",
          subtitle: "Support",
        }),
      ]),
      { limit: 1 },
    );

    expect(summary.recommendations).toHaveLength(1);
    expect(["customer_success", "hiring"]).toContain(summary.recommendations[0].playbook.domain);
  });

  it("returns no recommendations when the work graph has no playbook signals", () => {
    const summary = recommendPlaybooksFromGraph(
      graph([
        context({
          title: "Weekly internal notes",
          subtitle: "Ops",
          risk: "low",
          reasons: [],
          signals: {
            emails: 1,
            unreadEmails: 0,
            urgentEmails: 0,
            pendingActions: 0,
            commitments: 0,
            overdueCommitments: 0,
          },
        }),
      ]),
    );

    expect(summary.recommendations).toEqual([]);
    expect(summary.playbooks).toHaveLength(4);
  });
});
