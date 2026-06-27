import { describe, expect, it, vi } from "vitest";

// No Google token wired → getAuthedClient resolves to null, so a valid address
// fails with "Gmail not connected" (proving the recipient guard let it past).
vi.mock("../db.js", () => {
  const prisma = { userToken: { findFirst: vi.fn(async () => null) } };
  return { prisma, db: prisma };
});

import { sendEmail } from "../gmail.js";

// The recipient guard is the first check in sendEmail and returns before any
// network/DB access, so these cases exercise the real function with no mocks.
describe("sendEmail recipient guard", () => {
  it("rejects a comma-separated multi-recipient string", async () => {
    const result = await sendEmail("user-1", "alice@example.com, bob@example.com", "Hi", "Body");
    expect(result).toMatchObject({ error: expect.stringContaining("one recipient") });
  });

  it("rejects a semicolon-separated multi-recipient string", async () => {
    const result = await sendEmail("user-1", "alice@example.com; bob@example.com", "Hi", "Body");
    expect(result).toMatchObject({ error: expect.stringContaining("one recipient") });
  });

  it("rejects the angle-bracket display-name smuggling trick", async () => {
    // extractAddress() would resolve this to the valid `legit@z.com`, but the
    // raw comma must keep the second recipient from reaching the To header.
    const result = await sendEmail(
      "user-1",
      "alice@example.com, evil@attacker.com <legit@z.com>",
      "Hi",
      "Body",
    );
    expect(result).toMatchObject({ error: expect.stringContaining("one recipient") });
  });

  it("lets a single valid address past the recipient guard", async () => {
    // No Gmail token is wired in tests, so a clean address falls through the
    // guard and fails later with the connection error — proving the guard
    // itself did not reject it.
    const result = await sendEmail("user-1", "alice@example.com", "Hi", "Body");
    expect(result).toMatchObject({ error: expect.stringContaining("Gmail not connected") });
  });
});
