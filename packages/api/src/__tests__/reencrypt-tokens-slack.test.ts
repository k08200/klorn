/**
 * Key rotation covers the Slack connection's two ciphers (signing secret and
 * user token) from the day the table exists, so a rotation never strands a
 * Slack connection on a retired key.
 */

import { describe, expect, it, vi } from "vitest";

const slackFindMany = vi.hoisted(() =>
  vi.fn(async () => [
    { id: "s1", signingSecretCipher: "v1:old-secret", userTokenCipher: "v1:old-token" },
  ]),
);
const slackUpdateMany = vi.hoisted(() => vi.fn(async (_args: unknown) => ({ count: 1 })));
const disconnect = vi.hoisted(() => vi.fn(async () => {}));
const empty = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };

vi.mock("../db.js", () => ({
  prisma: {
    userToken: empty,
    linkedInboxAccount: empty,
    linkedCalendarAccount: empty,
    linkedDriveAccount: empty,
    user: empty,
    slackConnection: { findMany: slackFindMany, updateMany: slackUpdateMany },
    $disconnect: disconnect,
  },
}));
vi.mock("../crypto-tokens.js", () => ({
  activeKeyId: () => "k2",
  needsReencryption: (value: string) => value.startsWith("v1:"),
  reencryptToActiveKey: (value: string) => value.replace("v1:", "v2:k2:"),
}));

describe("re-encryption sweep — SlackConnection", () => {
  it("selects both Slack ciphers and rewrites them guarded by what it read", async () => {
    process.argv.push("--apply");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await import("../scripts/reencrypt-tokens.js");
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    logSpy.mockRestore();
    process.argv.pop();
    expect(slackFindMany).toHaveBeenCalledWith({
      select: { id: true, signingSecretCipher: true, userTokenCipher: true },
    });
    expect(slackUpdateMany).toHaveBeenCalledWith({
      where: { id: "s1", signingSecretCipher: "v1:old-secret", userTokenCipher: "v1:old-token" },
      data: { signingSecretCipher: "v2:k2:old-secret", userTokenCipher: "v2:k2:old-token" },
    });
  });
});
