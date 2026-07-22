import { describe, expect, it } from "vitest";
import {
  classifyMinedCommitment,
  type MinedCommitmentRow,
  type SourceEmailRow,
} from "../pim/commitment-cleanup.js";

// Retro-cleanup for ledger rows mined BEFORE the 2026-07-22 quality fixes
// (automated-sender gate, policy-notice filter, sender-perspective owner).
// The classifier must mirror the CURRENT ingestion pipeline exactly: a row is
// deleted iff today's pipeline would not have created it, re-attributed iff
// today's pipeline would have created it with a different owner, kept
// otherwise. No extra heuristics — cleanup and pipeline must not disagree.

const USER_EMAIL = "founder@example.com";

function row(overrides: Partial<MinedCommitmentRow> = {}): MinedCommitmentRow {
  return {
    id: "c-1",
    owner: "USER",
    evidenceText: "I'll push it back to them now.",
    confidence: 0.45,
    ...overrides,
  };
}

function email(overrides: Partial<SourceEmailRow> = {}): SourceEmailRow {
  return {
    from: "Colleague <colleague@partner.example>",
    fromAddress: "colleague@partner.example",
    subject: "Contract",
    body: "Got it. I'll push it back to them now.",
    snippet: null,
    labels: [],
    ...overrides,
  };
}

describe("classifyMinedCommitment", () => {
  it("deletes rows mined from automated senders (system-notification, mixed-case no-reply)", () => {
    const notice = email({
      from: "Trusted Traveler Program <No-Reply@ttp.example.gov>",
      fromAddress: "no-reply@ttp.example.gov",
      subject: "Your appointment",
      body: "You will not be allowed to join the queue for entry until 10 minutes prior to your scheduled appointment.",
    });
    const out = classifyMinedCommitment(
      row({ owner: "COUNTERPARTY", evidenceText: "You will not be allowed to join the queue" }),
      notice,
      USER_EMAIL,
    );
    expect(out.action).toBe("delete");

    const github = classifyMinedCommitment(
      row({ owner: "COUNTERPARTY", evidenceText: "Sarah will review the PR Friday" }),
      email({
        from: "notifications@github.com",
        fromAddress: "notifications@github.com",
        body: "Sarah will review the PR Friday.",
      }),
      USER_EMAIL,
    );
    expect(github.action).toBe("delete");
  });

  it("deletes rows mined from marketing mail (mirrors the firewall skip)", () => {
    const out = classifyMinedCommitment(
      row(),
      email({ labels: ["CATEGORY_PROMOTIONS"] }),
      USER_EMAIL,
    );
    expect(out.action).toBe("delete");
  });

  it("deletes rows whose evidence today's extractor no longer produces (policy notice)", () => {
    const out = classifyMinedCommitment(
      row({
        owner: "COUNTERPARTY",
        evidenceText:
          "You will not be allowed to join the queue for entry until 10 minutes prior to your scheduled appointment.",
      }),
      email({
        from: "Front Desk <frontdesk@venue.example>",
        fromAddress: "frontdesk@venue.example",
        body: "You will not be allowed to join the queue for entry until 10 minutes prior to your scheduled appointment.",
      }),
      USER_EMAIL,
    );
    expect(out.action).toBe("delete");
  });

  it("re-attributes the sender's first-person promise from USER to COUNTERPARTY", () => {
    const out = classifyMinedCommitment(row(), email(), USER_EMAIL);
    expect(out).toMatchObject({
      action: "reattribute",
      owner: "COUNTERPARTY",
      counterpartyEmail: "colleague@partner.example",
    });
  });

  it("keeps USER ownership when the user authored the email themselves", () => {
    const out = classifyMinedCommitment(
      row({ evidenceText: "I'll route it for signature immediately." }),
      email({
        from: `Founder <${USER_EMAIL}>`,
        fromAddress: USER_EMAIL,
        body: "I'll route it for signature immediately.",
      }),
      USER_EMAIL,
    );
    expect(out.action).toBe("keep");
  });

  it("keeps correctly-attributed counterparty promises", () => {
    const out = classifyMinedCommitment(
      row({ owner: "COUNTERPARTY", evidenceText: "Sarah will send the contract tomorrow" }),
      email({ body: "Sarah will send the contract tomorrow afternoon." }),
      USER_EMAIL,
    );
    expect(out.action).toBe("keep");
  });

  it("keeps rows whose source email is gone (cannot re-evaluate)", () => {
    const out = classifyMinedCommitment(row(), null, USER_EMAIL);
    expect(out.action).toBe("keep");
  });

  it("matches evidence against the subject line too (mining text was subject + body)", () => {
    // Ingestion mined [subject, body].join("\n\n") — a candidate can span or
    // start from subject text, so re-extraction must use the same input.
    const out = classifyMinedCommitment(
      row({ owner: "COUNTERPARTY", evidenceText: "Sarah will send the contract tomorrow" }),
      email({ subject: "Sarah will send the contract tomorrow", body: "See subject." }),
      USER_EMAIL,
    );
    expect(out.action).toBe("keep");
  });
});
