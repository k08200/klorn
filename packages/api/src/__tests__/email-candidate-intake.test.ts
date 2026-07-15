import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {}, db: {} }));

import {
  attachDuplicateHints,
  type CandidateIntakeView,
  candidateIdentity,
} from "../mail/email-candidate-intake.js";

function candidate(
  patch: Partial<CandidateIntakeView> & Pick<CandidateIntakeView, "emailId">,
): CandidateIntakeView {
  return {
    id: patch.emailId,
    emailId: patch.emailId,
    status: "READY_TO_REVIEW",
    name: null,
    role: null,
    contact: null,
    emailAddress: null,
    phone: null,
    summary: "candidate",
    confidence: 0.8,
    missingFields: [],
    evidenceFiles: [],
    notes: null,
    lastDetectedAt: "2026-05-12T00:00:00.000Z",
    reviewedAt: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    duplicateKey: null,
    duplicateCount: 1,
    duplicateEmailIds: [],
    duplicateReasons: [],
    ...patch,
  };
}

describe("candidate intake duplicate hints", () => {
  it("prefers stable email identity", () => {
    expect(
      candidateIdentity({
        emailAddress: "Actor <A@Example.com>",
        contact: null,
        phone: null,
        name: "A",
        role: "Actor",
      }),
    ).toEqual({
      key: "email:a@example.com",
      reasons: ["same_email"],
    });
  });

  it("marks candidates sharing email as duplicates", () => {
    const [first, second, third] = attachDuplicateHints([
      candidate({ emailId: "email-1", emailAddress: "a@example.com", name: "A" }),
      candidate({ emailId: "email-2", contact: "A <a@example.com>", name: "A" }),
      candidate({ emailId: "email-3", emailAddress: "b@example.com", name: "B" }),
    ]);

    expect(first.duplicateCount).toBe(2);
    expect(first.duplicateEmailIds).toEqual(["email-2"]);
    expect(second.duplicateCount).toBe(2);
    expect(second.duplicateEmailIds).toEqual(["email-1"]);
    expect(third.duplicateCount).toBe(1);
  });

  it("falls back to phone and name-role matches", () => {
    const rows = attachDuplicateHints([
      candidate({ emailId: "phone-1", phone: "+82 10-1234-5678" }),
      candidate({ emailId: "phone-2", contact: "01012345678" }),
      candidate({ emailId: "name-1", name: "Kim Hana", role: "Actor" }),
      candidate({ emailId: "name-2", name: "kim hana", role: "actor" }),
    ]);

    expect(rows[0].duplicateReasons).toEqual(["same_phone"]);
    expect(rows[1].duplicateReasons).toEqual(["same_phone"]);
    expect(rows[2].duplicateReasons).toEqual(["same_name_and_role"]);
    expect(rows[3].duplicateReasons).toEqual(["same_name_and_role"]);
  });
});
