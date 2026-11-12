/**
 * The Gmail baseline of IP24 is "what Gmail's High priority only setting would
 * ring for": inbox mail Gmail marked IMPORTANT. The snapshot is taken from the
 * stored labels when Klorn judges the mail. Only Gmail mail has a Gmail
 * marker: the IMAP and Outlook syncs map the user's own flag to "IMPORTANT",
 * which is not Gmail's importance and must read as unknown (null).
 */

import { describe, expect, it } from "vitest";
import {
  gmailImportantAtJudge,
  gmailImportantSnapshot,
} from "../judge/gmail-important-snapshot.js";

const GMAIL_ID = "18c2f0a1b2c3d4e5";

describe("gmailImportantAtJudge", () => {
  it("is true for Gmail inbox mail Gmail marked IMPORTANT", () => {
    expect(gmailImportantAtJudge(GMAIL_ID, ["INBOX", "UNREAD", "IMPORTANT"])).toBe(true);
  });

  it("is false for Gmail inbox mail without the marker", () => {
    expect(gmailImportantAtJudge(GMAIL_ID, ["INBOX", "UNREAD"])).toBe(false);
  });

  it("is false for Gmail mail outside the inbox (spam): Gmail never rings for it", () => {
    expect(gmailImportantAtJudge(GMAIL_ID, ["SPAM", "IMPORTANT"])).toBe(false);
  });

  it.each([
    ["an IMAP flag", "icloud-imap:me@icloud.com:42"],
    ["a Naver IMAP flag", "naver-imap:me@naver.com:5"],
    ["an Outlook flag", "outlook:me@outlook.com:AAMkAGI2"],
    ["Klorn's own mailbox", "klorn:3f2a"],
  ])("is null (unknown) for %s, even when the sync wrote IMPORTANT", (_what, id) => {
    expect(gmailImportantAtJudge(id, ["INBOX", "IMPORTANT"])).toBeNull();
  });

  it("is null when the message id is not known", () => {
    expect(gmailImportantAtJudge(undefined, ["INBOX", "IMPORTANT"])).toBeNull();
  });
});

describe("gmailImportantSnapshot — only a fresh first judgement is a snapshot", () => {
  const NOW = new Date("2026-11-12T10:00:00Z");
  const HOUR = 3_600_000;
  const mail = (ageMs: number) => ({
    gmailId: GMAIL_ID,
    labels: ["INBOX", "IMPORTANT"],
    receivedAt: new Date(NOW.getTime() - ageMs),
  });

  it("reads Gmail's marker for mail judged within the ring window of arrival", () => {
    expect(gmailImportantSnapshot(mail(5 * HOUR), { rejudge: false }, NOW)).toBe(true);
  });

  it("is null for a re-judge: the labels may have changed since the first judgement", () => {
    expect(gmailImportantSnapshot(mail(60_000), { rejudge: true }, NOW)).toBeNull();
  });

  it("is null for mail judged late (the backfill sweep): sync has rewritten its labels since", () => {
    // Gmail adds IMPORTANT after a reply, and sync copies the live labels onto
    // the stored row; Klorn never rings mail this old either (6h recency).
    expect(gmailImportantSnapshot(mail(7 * HOUR), { rejudge: false }, NOW)).toBeNull();
  });
});
