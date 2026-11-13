import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ prisma: { emailMessage: { findUnique } }, db: {} }));

const {
  needsAttachmentScan,
  rememberAttachmentScan,
  resetAttachmentScanMemo,
  wasAttachmentScanned,
} = await import("../mail/attachment-scan-gate.js");

beforeEach(() => {
  findUnique.mockReset();
  resetAttachmentScanMemo();
});

describe("needsAttachmentScan", () => {
  it("is true for a new message and for a row without attachment rows, false otherwise", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await needsAttachmentScan("u1", "icloud-imap:me@icloud.com:7")).toBe(true);
    findUnique.mockResolvedValueOnce({ _count: { attachments: 0 } });
    expect(await needsAttachmentScan("u1", "icloud-imap:me@icloud.com:7")).toBe(true);
    findUnique.mockResolvedValueOnce({ _count: { attachments: 2 } });
    expect(await needsAttachmentScan("u1", "icloud-imap:me@icloud.com:7")).toBe(false);

    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_gmailId: { userId: "u1", gmailId: "icloud-imap:me@icloud.com:7" } },
      select: { _count: { select: { attachments: true } } },
    });
  });
});

describe("the scanned-message memo", () => {
  it("is keyed by user and message", () => {
    rememberAttachmentScan("u1", "m1");
    expect(wasAttachmentScanned("u1", "m1")).toBe(true);
    expect(wasAttachmentScanned("u2", "m1")).toBe(false);
    expect(wasAttachmentScanned("u1", "m2")).toBe(false);
  });

  it("stays bounded, forgetting the oldest entry first", () => {
    for (let i = 0; i < 20_001; i++) rememberAttachmentScan("u", `m${i}`);
    expect(wasAttachmentScanned("u", "m0")).toBe(false);
    expect(wasAttachmentScanned("u", "m1")).toBe(true);
    expect(wasAttachmentScanned("u", "m20000")).toBe(true);
  });
});
