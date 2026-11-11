/**
 * The scheduler's co-attendance queue checks CALENDAR_COATTENDANCE_ENABLED per
 * user before it queues anything (coattendance-job.ts). The pass behind it is
 * mocked here, so these tests see the queue's own gate and not the pass's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCoAttendancePass = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../pim/coattendance/coattendance-sync.js", () => ({ runCoAttendancePass }));

import {
  _drainCoAttendanceQueueForTests,
  enqueueCoAttendance,
} from "../pim/coattendance/coattendance-job.js";

const FLAG = "CALENDAR_COATTENDANCE_ENABLED";

async function queued(): Promise<string[]> {
  enqueueCoAttendance("u-member", { includeLinked: false });
  enqueueCoAttendance("u-outsider", { includeLinked: false });
  await _drainCoAttendanceQueueForTests();
  return runCoAttendancePass.mock.calls.map((c) => (c as unknown as [string])[0]);
}

beforeEach(() => {
  runCoAttendancePass.mockClear();
  vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "u-member");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("enqueueCoAttendance", () => {
  it("cohort: queues the cohort member's pass only", async () => {
    vi.stubEnv(FLAG, "cohort");
    expect(await queued()).toEqual(["u-member"]);
  });

  it("true: queues every user's pass", async () => {
    vi.stubEnv(FLAG, "true");
    expect(await queued()).toEqual(["u-member", "u-outsider"]);
  });

  it("off: queues nothing", async () => {
    vi.stubEnv(FLAG, "");
    expect(await queued()).toEqual([]);
  });
});
