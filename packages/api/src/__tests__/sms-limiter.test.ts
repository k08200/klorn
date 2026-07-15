import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAllSmsWindowsForTests,
  checkAndRecordSmsSend,
  getSmsUsage,
  smsDailyCap,
} from "../notify/sms-limiter.js";

const ORIGINAL_CAP = process.env.SMS_DAILY_CAP_PER_USER;

describe("sms-limiter", () => {
  beforeEach(() => {
    _resetAllSmsWindowsForTests();
    delete process.env.SMS_DAILY_CAP_PER_USER;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 24, 12, 0, 0)));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_CAP === undefined) {
      delete process.env.SMS_DAILY_CAP_PER_USER;
    } else {
      process.env.SMS_DAILY_CAP_PER_USER = ORIGINAL_CAP;
    }
  });

  it("defaults the daily cap to 10", () => {
    expect(smsDailyCap()).toBe(10);
  });

  it("honors SMS_DAILY_CAP_PER_USER override", () => {
    process.env.SMS_DAILY_CAP_PER_USER = "3";
    expect(smsDailyCap()).toBe(3);
  });

  it("allows sends under the cap and blocks at the cap", () => {
    process.env.SMS_DAILY_CAP_PER_USER = "3";
    expect(checkAndRecordSmsSend("u1")).toBe(true);
    expect(checkAndRecordSmsSend("u1")).toBe(true);
    expect(checkAndRecordSmsSend("u1")).toBe(true);
    expect(checkAndRecordSmsSend("u1")).toBe(false);
    expect(checkAndRecordSmsSend("u1")).toBe(false);
  });

  it("keeps per-user buckets independent", () => {
    process.env.SMS_DAILY_CAP_PER_USER = "1";
    expect(checkAndRecordSmsSend("alice")).toBe(true);
    expect(checkAndRecordSmsSend("alice")).toBe(false);
    expect(checkAndRecordSmsSend("bob")).toBe(true);
  });

  it("resets at the next UTC day", () => {
    process.env.SMS_DAILY_CAP_PER_USER = "1";
    expect(checkAndRecordSmsSend("u1")).toBe(true);
    expect(checkAndRecordSmsSend("u1")).toBe(false);

    // Jump past UTC midnight
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 25, 0, 1, 0)));

    expect(checkAndRecordSmsSend("u1")).toBe(true);
  });

  it("treats cap=0 as SMS disabled (always blocked)", () => {
    process.env.SMS_DAILY_CAP_PER_USER = "0";
    expect(checkAndRecordSmsSend("u1")).toBe(false);
  });

  it("getSmsUsage reports used/cap/resetAt", () => {
    process.env.SMS_DAILY_CAP_PER_USER = "5";
    checkAndRecordSmsSend("u1");
    checkAndRecordSmsSend("u1");
    const snap = getSmsUsage("u1");
    expect(snap.used).toBe(2);
    expect(snap.cap).toBe(5);
    expect(snap.resetAt.getUTCHours()).toBe(0);
  });
});
