import { beforeEach, describe, expect, it, vi } from "vitest";

// listEmails must forward an optional Gmail search query (`q`) so the chat
// surface can FIND mail ("from:kim newer_than:7d"), not just list recent inbox.

const listMock = vi.fn();
const getMock = vi.fn();

vi.mock("googleapis", () => {
  class OAuth2 {
    setCredentials() {}
    on() {}
  }
  return {
    google: {
      auth: { OAuth2 },
      gmail: vi.fn(() => ({
        users: { messages: { list: listMock, get: getMock } },
      })),
    },
  };
});

// A wired Google token so getAuthedClient returns a client.
vi.mock("../db.js", () => {
  const prisma = {
    userToken: {
      findFirst: vi.fn(async () => ({
        id: "tok-1",
        userId: "user-1",
        provider: "google",
        accessToken: "enc-access",
        refreshToken: "enc-refresh",
        expiresAt: null,
      })),
    },
  };
  return { prisma, db: prisma };
});

// Pass-through crypto so the fake stored tokens survive decryption.
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (v: string) => v,
  decryptOptional: (v: string | null) => v,
  encryptToken: (v: string) => v,
  encryptOptional: (v: string | null) => v,
}));

import { listEmails } from "../gmail.js";

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  listMock.mockResolvedValue({ data: { messages: [] } });
});

describe("listEmails search query", () => {
  it("forwards the query as Gmail q", async () => {
    await listEmails("user-1", 10, "from:kim@example.com newer_than:7d");
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ q: "from:kim@example.com newer_than:7d" }),
    );
  });

  it("omits q entirely when no query is given", async () => {
    await listEmails("user-1", 10);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0]?.[0]).not.toHaveProperty("q");
  });

  it("ignores a blank query", async () => {
    await listEmails("user-1", 10, "   ");
    expect(listMock.mock.calls[0]?.[0]).not.toHaveProperty("q");
  });
});
