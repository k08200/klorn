import { beforeEach, describe, expect, it, vi } from "vitest";

// Gmail returns a different attachmentId on every messages.get for the same
// message, so the parsed attachment must carry an identity that survives a
// re-fetch: the MIME partId ("The immutable ID of the message part").
const getMock = vi.fn();
const attachmentsGetMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({
      users: { messages: { get: getMock, attachments: { get: attachmentsGetMock } } },
    })),
  },
}));
vi.mock("../mail/email-attachment-text.js", () => ({
  extractAttachmentContent: vi.fn(() => ({ text: "" })),
  isReadableEmailAttachment: vi.fn(() => false),
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  isGoogleAuthError: () => false,
  isGoogleNotFoundError: () => false,
  markGoogleTokenForReconnect: vi.fn(async () => {}),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

let fetchCount = 0;

// One message, re-fetched: same MIME tree, freshly minted attachment ids.
function detail(root: Record<string, unknown>) {
  fetchCount += 1;
  return {
    data: {
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "From", value: "a@b.test" },
          { name: "Subject", value: "s" },
        ],
        ...root,
      },
    },
  };
}

function multipart() {
  return {
    partId: "",
    mimeType: "multipart/mixed",
    parts: [
      { partId: "0", mimeType: "text/plain", body: { data: Buffer.from("hi").toString("base64url") } },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "contract.pdf",
        body: { attachmentId: `ANGj-pdf-${fetchCount}`, size: 1024 },
      },
      {
        partId: "2",
        mimeType: "multipart/related",
        parts: [
          {
            partId: "2.1",
            mimeType: "image/png",
            filename: "contract.pdf",
            body: { attachmentId: `ANGj-png-${fetchCount}`, size: 1024 },
          },
        ],
      },
    ],
  };
}

describe("Gmail attachment identity across re-fetches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCount = 0;
  });

  it("keys each attachment by its MIME partId, not the per-fetch attachmentId", async () => {
    getMock.mockImplementation(async () => detail(multipart()));
    const { fetchGmailEmailById } = await import("../mail/gmail-fetch.js");

    const first = await fetchGmailEmailById("user-1", "m1");
    const second = await fetchGmailEmailById("user-1", "m1");

    const keys = (email: typeof first) => email?.attachments.map((a) => a.partKey);
    expect(keys(first)).toEqual(["1", "2.1"]);
    expect(keys(second)).toEqual(keys(first));
    // The fetch handle still changes; it is stored for attachments.get only.
    expect(first?.attachments[0]?.gmailAttachmentId).not.toBe(
      second?.attachments[0]?.gmailAttachmentId,
    );
  });

  it("falls back to the part's position when Gmail sends no partId", async () => {
    getMock.mockImplementation(async () =>
      detail({
        mimeType: "application/pdf",
        filename: "only.pdf",
        body: { attachmentId: `ANGj-root-${fetchCount}`, size: 10 },
      }),
    );
    const { fetchGmailEmailById } = await import("../mail/gmail-fetch.js");

    const first = await fetchGmailEmailById("user-1", "m1");
    const second = await fetchGmailEmailById("user-1", "m1");

    expect(first?.attachments.map((a) => a.partKey)).toEqual(["index:0"]);
    expect(second?.attachments.map((a) => a.partKey)).toEqual(["index:0"]);
  });
});
