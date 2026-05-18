import { describe, expect, it, vi } from "vitest";

// Capture upserts so we can assert what the hook would have written
// without ever touching a real DB.
const upsertCalls: unknown[] = [];

vi.mock("../commitments.js", () => ({
  upsertCommitment: vi.fn(async (userId: string, input: unknown) => {
    upsertCalls.push({ userId, input });
    return { id: "c-1" };
  }),
}));

import { openCommitmentForCandidateTransition } from "../candidate-commitments.js";

const baseCandidate = {
  id: "intake-1",
  name: "Jaewoo Kim",
  contactEmail: "jaewoo@example.com",
  emailId: "email-1",
  threadId: "thread-1",
};

describe("openCommitmentForCandidateTransition", () => {
  it("returns null and writes nothing for unmapped statuses", async () => {
    upsertCalls.length = 0;
    expect(
      await openCommitmentForCandidateTransition("user-1", baseCandidate, "NEEDS_INFO"),
    ).toBeNull();
    expect(
      await openCommitmentForCandidateTransition("user-1", baseCandidate, "REJECTED"),
    ).toBeNull();
    expect(
      await openCommitmentForCandidateTransition("user-1", baseCandidate, "ARCHIVED"),
    ).toBeNull();
    expect(upsertCalls.length).toBe(0);
  });

  it("opens a SHORTLISTED commitment owned by the user with a 5-day deadline", async () => {
    upsertCalls.length = 0;
    const before = Date.now();
    const result = await openCommitmentForCandidateTransition(
      "user-1",
      baseCandidate,
      "SHORTLISTED",
    );
    const after = Date.now();
    expect(result?.id).toBe("c-1");
    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0] as { userId: string; input: Record<string, unknown> };
    expect(call.userId).toBe("user-1");
    expect(call.input.owner).toBe("USER");
    expect(call.input.title).toBe("Send interview request to Jaewoo Kim");
    expect(call.input.dedupKey).toBe("candidate_intake:intake-1:SHORTLISTED");
    expect(call.input.sourceId).toBe("email-1");
    const due = call.input.dueAt as Date;
    expect(due.getTime()).toBeGreaterThanOrEqual(before + 5 * 24 * 60 * 60 * 1000 - 1000);
    expect(due.getTime()).toBeLessThanOrEqual(after + 5 * 24 * 60 * 60 * 1000 + 1000);
  });

  it("opens a CONTACTED commitment owned by the counterparty", async () => {
    upsertCalls.length = 0;
    await openCommitmentForCandidateTransition("user-1", baseCandidate, "CONTACTED");
    const call = upsertCalls[0] as { input: Record<string, unknown> };
    expect(call.input.owner).toBe("COUNTERPARTY");
    expect(call.input.title).toBe("Wait for Jaewoo Kim's reply");
    expect(call.input.dedupKey).toBe("candidate_intake:intake-1:CONTACTED");
    expect(call.input.counterpartyEmail).toBe("jaewoo@example.com");
  });

  it("falls back to a generic name when the candidate has no name", async () => {
    upsertCalls.length = 0;
    await openCommitmentForCandidateTransition(
      "user-1",
      { ...baseCandidate, name: null },
      "REVIEWING",
    );
    const call = upsertCalls[0] as { input: Record<string, unknown> };
    expect(call.input.title).toBe("Decide on this candidate");
  });
});
