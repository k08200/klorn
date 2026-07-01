import { beforeEach, describe, expect, it, vi } from "vitest";

// Gmail client surface: list returns ids, get returns per-message detail.
const listMock = vi.fn();
const getMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({ users: { messages: { list: listMock, get: getMock } } })),
  },
}));

// Attachment extraction is irrelevant here (no attachment parts) — stub it out
// so the module loads without its heavy text-extraction deps.
vi.mock("../email-attachment-text.js", () => ({
  extractAttachmentContent: vi.fn(() => ({ text: "" })),
  isReadableEmailAttachment: vi.fn(() => false),
}));

// Keep the real classification logic of the error helpers (that branch behaviour
// is exactly what we're testing) but stub auth/connection side effects.
const markGoogleTokenForReconnect = vi.fn(async () => {});
vi.mock("../gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  isGoogleAuthError: (e: { response?: { status?: number } }) => e?.response?.status === 401,
  isGoogleNotFoundError: (e: { response?: { status?: number } }) =>
    e?.response?.status === 404 || e?.response?.status === 410,
  markGoogleTokenForReconnect,
}));

const captureError = vi.fn();
vi.mock("../sentry.js", () => ({ captureError: (...args: unknown[]) => captureError(...args) }));

function detailFor(id: string) {
  return {
    data: {
      id,
      threadId: `thread-${id}`,
      labelIds: ["INBOX"],
      snippet: `snippet ${id}`,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: `sender-${id}@example.com` },
          { name: "Subject", value: `subject ${id}` },
          { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
        ],
        body: { data: Buffer.from(`body ${id}`).toString("base64url") },
      },
    },
  };
}

function httpError(status: number) {
  return { response: { status } };
}

describe("fetchGmailEmails — parallel fetch with per-message isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns emails in list (newest-first) order despite out-of-order completion", async () => {
    listMock.mockResolvedValue({ data: { messages: [{ id: "a" }, { id: "b" }, { id: "c" }] } });
    // 'a' resolves slowest, 'c' fastest — order must still follow the list.
    const delays: Record<string, number> = { a: 30, b: 10, c: 0 };
    getMock.mockImplementation(async ({ id }: { id: string }) => {
      await new Promise((r) => setTimeout(r, delays[id]));
      return detailFor(id);
    });

    const { fetchGmailEmails } = await import("../gmail-fetch.js");
    const emails = await fetchGmailEmails("user-1", 30);

    expect(emails?.map((e) => e.gmailId)).toEqual(["a", "b", "c"]);
  });

  it("skips a message deleted between list and get (404) without sinking the batch", async () => {
    listMock.mockResolvedValue({ data: { messages: [{ id: "a" }, { id: "gone" }, { id: "c" }] } });
    getMock.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "gone") throw httpError(404);
      return detailFor(id);
    });

    const { fetchGmailEmails } = await import("../gmail-fetch.js");
    const emails = await fetchGmailEmails("user-1", 30);

    expect(emails?.map((e) => e.gmailId)).toEqual(["a", "c"]);
    // A deleted-message race is expected — it must NOT be reported as an error.
    expect(captureError).not.toHaveBeenCalled();
  });

  it("drops a single transient-error message but keeps the rest, and reports it", async () => {
    listMock.mockResolvedValue({ data: { messages: [{ id: "a" }, { id: "boom" }, { id: "c" }] } });
    getMock.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "boom") throw httpError(429);
      return detailFor(id);
    });

    const { fetchGmailEmails } = await import("../gmail-fetch.js");
    const emails = await fetchGmailEmails("user-1", 30);

    // One bad message must not abort the other in-flight fetches.
    expect(emails?.map((e) => e.gmailId)).toEqual(["a", "c"]);
    // ...but the failure is never silent.
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extra: expect.objectContaining({ gmailId: "boom" }) }),
    );
  });

  it("aborts the batch and flags reconnect on an auth error", async () => {
    listMock.mockResolvedValue({ data: { messages: [{ id: "a" }, { id: "b" }] } });
    getMock.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "b") throw httpError(401);
      return detailFor(id);
    });

    const { fetchGmailEmails } = await import("../gmail-fetch.js");
    const result = await fetchGmailEmails("user-1", 30);

    // Auth failure must surface as a reconnect signal, not a partial result.
    expect(result).toBeNull();
    expect(markGoogleTokenForReconnect).toHaveBeenCalledWith("user-1");
  });
});

describe("fetchGmailEmailById — primary vs linked auth handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("flags PRIMARY reconnect on a primary auth error (no linked client)", async () => {
    getMock.mockRejectedValue(httpError(401));

    const { fetchGmailEmailById } = await import("../gmail-fetch.js");
    const result = await fetchGmailEmailById("user-1", "g1");

    expect(result).toBeNull();
    expect(markGoogleTokenForReconnect).toHaveBeenCalledWith("user-1");
  });

  it("does NOT poison the primary token on a LINKED auth error, but still leaves a signal", async () => {
    getMock.mockRejectedValue(httpError(401));
    const linkedClient = {} as never;

    const { fetchGmailEmailById } = await import("../gmail-fetch.js");
    const result = await fetchGmailEmailById("user-1", "g1", linkedClient);

    expect(result).toBeNull();
    // The security invariant: a revoked LINKED token must never mark the healthy
    // primary connection for reconnect.
    expect(markGoogleTokenForReconnect).not.toHaveBeenCalled();
    // ...but the failure must not vanish (the undo route only returns a bare 502).
    expect(captureError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extra: expect.objectContaining({ gmailId: "g1" }) }),
    );
  });

  it("returns the parsed email on success", async () => {
    getMock.mockResolvedValue(detailFor("g1"));

    const { fetchGmailEmailById } = await import("../gmail-fetch.js");
    const email = await fetchGmailEmailById("user-1", "g1");

    expect(email?.gmailId).toBe("g1");
    expect(markGoogleTokenForReconnect).not.toHaveBeenCalled();
  });
});
