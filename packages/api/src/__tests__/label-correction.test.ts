/**
 * Label correction — moving a message between Klorn/* labels in Gmail is the
 * same act as moving a row in the app, and must reach the same ledger.
 *
 * SaneBox's whole learning loop is "drag between folders". Label mode gave us
 * the folders; this closes the loop by feeding the drag back as a correction
 * through the EXISTING override path, not a second one beside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const laneForLabelIds = vi.hoisted(() => vi.fn());
const isLabelModeEnabled = vi.hoisted(() => vi.fn(() => true));
const overrideAttentionTier = vi.hoisted(() => vi.fn());
const attentionFindFirst = vi.hoisted(() => vi.fn());

vi.mock("../mail/gmail-labels.js", () => ({ laneForLabelIds, isLabelModeEnabled }));
vi.mock("../judge/attention-override.js", () => ({ overrideAttentionTier }));
vi.mock("../db.js", () => ({
  prisma: { attentionItem: { findFirst: attentionFindFirst } },
  db: { attentionItem: { findFirst: attentionFindFirst } },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { reconcileLabelCorrection } from "../judge/label-correction.js";

const USER = "user-1";
const EMAIL = "email-db-1";
const LABEL_IDS = ["INBOX", "Label_push"];

beforeEach(() => {
  vi.clearAllMocks();
  isLabelModeEnabled.mockReturnValue(true);
  laneForLabelIds.mockResolvedValue("PUSH");
  attentionFindFirst.mockResolvedValue({ id: "item-1", tier: "QUEUE" });
  overrideAttentionTier.mockResolvedValue({ ok: true, tier: "PUSH" });
});

describe("reconcileLabelCorrection", () => {
  it("does nothing at all when label mode is off", async () => {
    isLabelModeEnabled.mockReturnValue(false);
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("skipped");
    expect(laneForLabelIds).not.toHaveBeenCalled();
    expect(attentionFindFirst).not.toHaveBeenCalled();
  });

  it("skips when the message carries no Klorn lane label", async () => {
    laneForLabelIds.mockResolvedValue(null);
    await expect(reconcileLabelCorrection(USER, EMAIL, ["INBOX"])).resolves.toBe("skipped");
    expect(attentionFindFirst).not.toHaveBeenCalled();
  });

  it("resolves the lane before touching the database, so quiet mail costs no query", async () => {
    laneForLabelIds.mockResolvedValue(null);
    await reconcileLabelCorrection(USER, EMAIL, LABEL_IDS);
    expect(laneForLabelIds).toHaveBeenCalled();
    expect(attentionFindFirst).not.toHaveBeenCalled();
  });

  it("threads the linked inbox id so labels resolve against the right account", async () => {
    await reconcileLabelCorrection(USER, EMAIL, LABEL_IDS, "linked-9");
    expect(laneForLabelIds).toHaveBeenCalledWith(USER, LABEL_IDS, "linked-9");
  });

  it("is a no-op when the label already agrees with the stored tier", async () => {
    attentionFindFirst.mockResolvedValue({ id: "item-1", tier: "PUSH" });
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("unchanged");
    expect(overrideAttentionTier).not.toHaveBeenCalled();
  });

  it("records a correction through the existing override path when they disagree", async () => {
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("corrected");
    expect(overrideAttentionTier).toHaveBeenCalledWith(USER, "item-1", "PUSH");
  });

  it("only considers the OPEN email item for this message", async () => {
    await reconcileLabelCorrection(USER, EMAIL, LABEL_IDS);
    expect(attentionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, source: "EMAIL", sourceId: EMAIL, status: "OPEN" },
      }),
    );
  });

  it("never reads a stale label as a human correction of an item an MCP agent moved (step A2b)", async () => {
    // The agent changed the tier in the database and wrote no Gmail label, so the
    // label Klorn stamped earlier now disagrees with the tier. That disagreement
    // is the agent's doing, not a human dragging the label: recording it through
    // the override path would undo the change AND mint a false human correction.
    attentionFindFirst.mockResolvedValue({
      id: "item-1",
      tier: "QUEUE",
      agentTierSetAt: new Date("2026-09-30T09:00:00Z"),
    });
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("skipped");
    expect(overrideAttentionTier).not.toHaveBeenCalled();
  });

  it("selects the agent stamp so it can tell the two apart", async () => {
    await reconcileLabelCorrection(USER, EMAIL, LABEL_IDS);
    expect(attentionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, tier: true, agentTierSetAt: true } }),
    );
  });

  it("skips when there is no open item to correct", async () => {
    attentionFindFirst.mockResolvedValue(null);
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("skipped");
    expect(overrideAttentionTier).not.toHaveBeenCalled();
  });

  it("reports skipped, not corrected, when the override says the item vanished", async () => {
    overrideAttentionTier.mockResolvedValue({ ok: false, reason: "not_found" });
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("skipped");
  });

  it("never throws — a sync must not fail because a correction could not be recorded", async () => {
    overrideAttentionTier.mockRejectedValue(new Error("db down"));
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("skipped");
  });

  it("never throws when the lane lookup itself fails", async () => {
    laneForLabelIds.mockRejectedValue(new Error("gmail down"));
    await expect(reconcileLabelCorrection(USER, EMAIL, LABEL_IDS)).resolves.toBe("skipped");
  });
});
