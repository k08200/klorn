import type { UserCorrectionFixture } from "./mail/email-feedback-fixtures.js";
import { classifyPriorityDetailed } from "./mail/email-sync.js";

export type EmailPriorityValue = "URGENT" | "NORMAL" | "LOW";

export interface EmailPriorityRegressionFixture {
  id: string;
  from: string;
  subject: string;
  labels?: string[];
  expectedSyncPriority: EmailPriorityValue;
}

export type UserCorrectionEvalStatus =
  | "now_matches_user"
  | "still_matches_captured_heuristic"
  | "changed_but_still_mismatched";

export interface EmailPriorityEvalCase {
  id: string;
  expectedPriority: EmailPriorityValue;
  actualPriority: EmailPriorityValue;
  matched: boolean;
  reason: string | null;
  signals: string[];
}

export interface UserCorrectionEvalCase extends EmailPriorityEvalCase {
  capturedAt: string;
  capturedPriority: EmailPriorityValue;
  status: UserCorrectionEvalStatus;
}

export interface EmailPriorityEvalReport<TCase extends EmailPriorityEvalCase> {
  total: number;
  matched: number;
  mismatched: number;
  matchRate: number;
  cases: TCase[];
  mismatches: TCase[];
}

export interface UserCorrectionEvalReport extends EmailPriorityEvalReport<UserCorrectionEvalCase> {
  stillMatchesCapturedHeuristic: number;
  changedButStillMismatched: number;
  nowMatchesUser: number;
}

export function evaluateEmailPriorityFixtures<TFixture extends EmailPriorityRegressionFixture>(
  fixtures: TFixture[],
): EmailPriorityEvalReport<EmailPriorityEvalCase> {
  const cases = fixtures.map((fixture) => {
    const actual = classifyPriorityDetailed(fixture.from, fixture.subject, fixture.labels ?? []);
    return {
      id: fixture.id,
      expectedPriority: fixture.expectedSyncPriority,
      actualPriority: actual.priority,
      matched: actual.priority === fixture.expectedSyncPriority,
      reason: actual.reason,
      signals: actual.signals,
    };
  });

  return summarizeCases(cases);
}

export function evaluateUserCorrectionFixtures(
  fixtures: UserCorrectionFixture[],
): UserCorrectionEvalReport {
  const cases = fixtures.map((fixture) => {
    const actual = classifyPriorityDetailed(fixture.from, fixture.subject, fixture.labels);
    const matched = actual.priority === fixture.expectedSyncPriority;
    return {
      id: fixture.id,
      capturedAt: fixture.capturedAt,
      capturedPriority: fixture.capturedHeuristic.priority,
      expectedPriority: fixture.expectedSyncPriority,
      actualPriority: actual.priority,
      matched,
      reason: actual.reason,
      signals: actual.signals,
      status: getUserCorrectionStatus({
        actualPriority: actual.priority,
        capturedPriority: fixture.capturedHeuristic.priority,
        expectedPriority: fixture.expectedSyncPriority,
      }),
    };
  });

  const summary = summarizeCases(cases);
  return {
    ...summary,
    stillMatchesCapturedHeuristic: cases.filter(
      (item) => item.status === "still_matches_captured_heuristic",
    ).length,
    changedButStillMismatched: cases.filter(
      (item) => item.status === "changed_but_still_mismatched",
    ).length,
    nowMatchesUser: cases.filter((item) => item.status === "now_matches_user").length,
  };
}

function summarizeCases<TCase extends EmailPriorityEvalCase>(
  cases: TCase[],
): EmailPriorityEvalReport<TCase> {
  const matched = cases.filter((item) => item.matched).length;
  const total = cases.length;
  return {
    total,
    matched,
    mismatched: total - matched,
    matchRate: total === 0 ? 1 : matched / total,
    cases,
    mismatches: cases.filter((item) => !item.matched),
  };
}

function getUserCorrectionStatus(input: {
  actualPriority: EmailPriorityValue;
  capturedPriority: EmailPriorityValue;
  expectedPriority: EmailPriorityValue;
}): UserCorrectionEvalStatus {
  if (input.actualPriority === input.expectedPriority) return "now_matches_user";
  if (input.actualPriority === input.capturedPriority) return "still_matches_captured_heuristic";
  return "changed_but_still_mismatched";
}
