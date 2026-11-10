/**
 * Gmail label mode — write the lane back to Gmail so the user never has to
 * open Klorn to get the benefit.
 *
 * Gmail is mocked at the googleapis boundary; gmail.js helpers are mocked at
 * their module boundary (repo convention). No network, no DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const labelsList = vi.hoisted(() => vi.fn());
const labelsCreate = vi.hoisted(() => vi.fn());
const messagesModify = vi.hoisted(() => vi.fn());
const resolveMailClient = vi.hoisted(() => vi.fn());
const markLinkedInboxForReconnect = vi.hoisted(() => vi.fn());
const isGoogleAuthError = vi.hoisted(() => vi.fn(() => false));

vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: {
        labels: { list: labelsList, create: labelsCreate },
        messages: { modify: messagesModify },
      },
    }),
  },
}));

vi.mock("../mail/gmail.js", () => ({
  resolveMailClient,
  markLinkedInboxForReconnect,
  isGoogleAuthError,
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  __resetLabelCacheForTests,
  applyLaneLabel,
  isLabelModeEnabled,
  LANE_LABELS,
  laneForLabelIds,
} from "../mail/gmail-labels.js";

const USER = "user-1";
const MSG = "gmail-msg-1";

/** Gmail's labels.list shape, with every lane already present. */
function allLanesExist() {
  return {
    data: {
      labels: Object.entries(LANE_LABELS).map(([tier, name]) => ({
        id: `id-${tier}`,
        name,
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetLabelCacheForTests();
  process.env.GMAIL_LABEL_MODE_ENABLED = "true";
  resolveMailClient.mockResolvedValue({});
  labelsList.mockResolvedValue(allLanesExist());
  labelsCreate.mockImplementation(async ({ requestBody }: { requestBody: { name: string } }) => ({
    data: { id: `made-${requestBody.name}`, name: requestBody.name },
  }));
  messagesModify.mockResolvedValue({});
  isGoogleAuthError.mockReturnValue(false);
});

describe("isLabelModeEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    delete process.env.GMAIL_LABEL_MODE_ENABLED;
    expect(isLabelModeEnabled()).toBe(false);
    process.env.GMAIL_LABEL_MODE_ENABLED = "yes";
    expect(isLabelModeEnabled()).toBe(false);
    process.env.GMAIL_LABEL_MODE_ENABLED = "true";
    expect(isLabelModeEnabled()).toBe(true);
  });
});

describe("LANE_LABELS", () => {
  it("covers all five lanes and nests them under one parent", () => {
    expect(Object.keys(LANE_LABELS).sort()).toEqual(["INFO", "MEETING", "PUSH", "QUEUE", "SILENT"]);
    for (const name of Object.values(LANE_LABELS)) {
      expect(name.startsWith("Klorn/")).toBe(true);
    }
  });
});

describe("applyLaneLabel", () => {
  it("skips entirely when the flag is off — no Gmail call at all", async () => {
    delete process.env.GMAIL_LABEL_MODE_ENABLED;
    await expect(applyLaneLabel(USER, MSG, "PUSH")).resolves.toBe("skipped");
    expect(resolveMailClient).not.toHaveBeenCalled();
    expect(messagesModify).not.toHaveBeenCalled();
  });

  it("skips when there is no Google client — an IMAP account has no Gmail labels", async () => {
    resolveMailClient.mockResolvedValue(null);
    await expect(applyLaneLabel(USER, MSG, "QUEUE", "naver-account")).resolves.toBe("skipped");
    expect(messagesModify).not.toHaveBeenCalled();
  });

  it("threads the linked inbox id through, never assuming the primary account", async () => {
    await applyLaneLabel(USER, MSG, "QUEUE", "linked-42");
    expect(resolveMailClient).toHaveBeenCalledWith(USER, "linked-42");
  });

  it("adds the lane label and removes the other four, so exactly one lane sticks", async () => {
    await applyLaneLabel(USER, MSG, "PUSH");
    expect(messagesModify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "me",
        id: MSG,
        requestBody: {
          addLabelIds: ["id-PUSH"],
          removeLabelIds: expect.arrayContaining([
            "id-MEETING",
            "id-QUEUE",
            "id-INFO",
            "id-SILENT",
          ]),
        },
      }),
    );
    const body = messagesModify.mock.calls[0][0].requestBody;
    expect(body.removeLabelIds).toHaveLength(4);
    expect(body.removeLabelIds).not.toContain("id-PUSH");
  });

  it("creates only the lanes Gmail does not already have", async () => {
    labelsList.mockResolvedValue({
      data: { labels: [{ id: "id-PUSH", name: LANE_LABELS.PUSH }] },
    });
    await applyLaneLabel(USER, MSG, "PUSH");
    const created = labelsCreate.mock.calls.map((c) => c[0].requestBody.name).sort();
    expect(created).toEqual(
      [LANE_LABELS.MEETING, LANE_LABELS.QUEUE, LANE_LABELS.INFO, LANE_LABELS.SILENT].sort(),
    );
  });

  it("caches the label ids — a second message does not re-list", async () => {
    await applyLaneLabel(USER, MSG, "PUSH");
    await applyLaneLabel(USER, "gmail-msg-2", "QUEUE");
    expect(labelsList).toHaveBeenCalledTimes(1);
    expect(messagesModify).toHaveBeenCalledTimes(2);
  });

  it("caches per account, so a second inbox resolves its own label ids", async () => {
    await applyLaneLabel(USER, MSG, "PUSH", "inbox-a");
    await applyLaneLabel(USER, "gmail-msg-2", "PUSH", "inbox-b");
    expect(labelsList).toHaveBeenCalledTimes(2);
  });

  it("marks the inbox for reconnect on an auth error, and reports failure", async () => {
    isGoogleAuthError.mockReturnValue(true);
    messagesModify.mockRejectedValue(new Error("invalid_grant"));
    await expect(applyLaneLabel(USER, MSG, "PUSH", "linked-7")).resolves.toBe("failed");
    expect(markLinkedInboxForReconnect).toHaveBeenCalledWith(USER, "linked-7");
  });

  it("never throws — labelling is best-effort and must not fail classification", async () => {
    messagesModify.mockRejectedValue(new Error("Gmail exploded"));
    await expect(applyLaneLabel(USER, MSG, "PUSH")).resolves.toBe("failed");
  });

  it("does not poison the cache when listing fails", async () => {
    labelsList.mockRejectedValueOnce(new Error("rate limited"));
    await expect(applyLaneLabel(USER, MSG, "PUSH")).resolves.toBe("failed");

    labelsList.mockResolvedValue(allLanesExist());
    await expect(applyLaneLabel(USER, MSG, "PUSH")).resolves.toBe("applied");
  });

  it("skips the retired AUTO tier — labelling is a v2 surface", async () => {
    await expect(applyLaneLabel(USER, MSG, "AUTO")).resolves.toBe("skipped");
    expect(messagesModify).not.toHaveBeenCalled();
  });

  it("survives losing the create race — another message made the label first", async () => {
    // Cold cache + a burst of mail: every message lists, finds nothing, and
    // tries to create. One wins; the rest get 409 alreadyExists. Before the
    // fix, those messages threw and were never labelled again — applyLaneLabel
    // is fire-and-forget, so there is no retry behind it.
    labelsList.mockResolvedValueOnce({ data: { labels: [] } }).mockResolvedValue(allLanesExist());
    labelsCreate.mockRejectedValue({ response: { status: 409 } });

    await expect(applyLaneLabel(USER, MSG, "PUSH")).resolves.toBe("applied");
    expect(messagesModify).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ addLabelIds: ["id-PUSH"] }),
      }),
    );
  });

  it("re-lists only once when it loses the race, not once per lane", async () => {
    labelsList.mockResolvedValueOnce({ data: { labels: [] } }).mockResolvedValue(allLanesExist());
    labelsCreate.mockRejectedValue({ response: { status: 409 } });

    await applyLaneLabel(USER, MSG, "PUSH");
    expect(labelsList).toHaveBeenCalledTimes(2);
  });

  it("still fails when the label is genuinely missing after the re-list", async () => {
    labelsList.mockResolvedValue({ data: { labels: [] } });
    labelsCreate.mockRejectedValue({ response: { status: 409 } });
    await expect(applyLaneLabel(USER, MSG, "PUSH")).resolves.toBe("failed");
  });

  it("does not swallow a create failure that is not a conflict", async () => {
    labelsList.mockResolvedValue({ data: { labels: [] } });
    labelsCreate.mockRejectedValue({ response: { status: 500 } });
    await expect(applyLaneLabel(USER, MSG, "PUSH")).resolves.toBe("failed");
    expect(labelsList).toHaveBeenCalledTimes(1);
  });

  it("reports applied on the happy path", async () => {
    await expect(applyLaneLabel(USER, MSG, "SILENT")).resolves.toBe("applied");
  });
});

describe("laneForLabelIds", () => {
  it("returns null when label mode is off", async () => {
    delete process.env.GMAIL_LABEL_MODE_ENABLED;
    await expect(laneForLabelIds(USER, ["id-PUSH"])).resolves.toBeNull();
    expect(labelsList).not.toHaveBeenCalled();
  });

  it("returns null for a message with no labels at all", async () => {
    await expect(laneForLabelIds(USER, [])).resolves.toBeNull();
  });

  it("resolves the single lane a message carries", async () => {
    await expect(laneForLabelIds(USER, ["INBOX", "id-QUEUE"])).resolves.toBe("QUEUE");
  });

  it("returns null when no lane label is present", async () => {
    await expect(laneForLabelIds(USER, ["INBOX", "UNREAD"])).resolves.toBeNull();
  });

  it("returns null when two lanes are present — a hand edit we must not guess at", async () => {
    await expect(laneForLabelIds(USER, ["id-PUSH", "id-SILENT"])).resolves.toBeNull();
  });

  it("reuses the warm cache instead of listing again", async () => {
    await applyLaneLabel(USER, MSG, "PUSH");
    labelsList.mockClear();
    await expect(laneForLabelIds(USER, ["id-QUEUE"])).resolves.toBe("QUEUE");
    expect(labelsList).not.toHaveBeenCalled();
  });

  it("is read-only on a cold cache — it asks Gmail, it never creates a label", async () => {
    labelsList.mockResolvedValue({
      data: { labels: [{ id: "id-INFO", name: LANE_LABELS.INFO }] },
    });
    await expect(laneForLabelIds(USER, ["id-INFO"])).resolves.toBe("INFO");
    expect(labelsCreate).not.toHaveBeenCalled();
  });

  it("returns null when there is no Google client", async () => {
    resolveMailClient.mockResolvedValue(null);
    await expect(laneForLabelIds(USER, ["id-PUSH"])).resolves.toBeNull();
  });

  it("never throws when Gmail fails", async () => {
    labelsList.mockRejectedValue(new Error("gmail down"));
    await expect(laneForLabelIds(USER, ["id-PUSH"])).resolves.toBeNull();
  });
});
