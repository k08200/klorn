/**
 * getUserLlmCredentials must be TOTAL — it is awaited on the firewall hot path
 * and inside batch loops, so a throw would strand a whole sweep, not one email.
 * On any failure (DB blip or corrupt stored key) it degrades to the shared env
 * key ({} / null) and emits a signal, never throwing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const decryptOptional = vi.hoisted(() => vi.fn());
const captureError = vi.hoisted(() => vi.fn());
const isEntitled = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({ prisma: { user: { findUnique } }, db: {} }));
vi.mock("../crypto-tokens.js", () => ({ decryptOptional }));
vi.mock("../sentry.js", () => ({ captureError }));
vi.mock("../billing/stripe.js", () => ({ isEntitled }));

import { getUserLlmCredentials } from "../llm/llm-credentials.js";

beforeEach(() => {
  findUnique.mockReset();
  decryptOptional.mockReset();
  captureError.mockReset();
  isEntitled.mockReset();
  isEntitled.mockReturnValue(true);
  // Default: decrypt is identity on a "cipher:" prefix, null otherwise.
  decryptOptional.mockImplementation((v: string | null | undefined) =>
    v ? String(v).replace("cipher:", "") : null,
  );
});

describe("getUserLlmCredentials", () => {
  it("returns decrypted per-user keys when set", async () => {
    findUnique.mockResolvedValue({
      anthropicApiKey: "cipher:sk-ant-user",
      geminiApiKey: "cipher:gem-user",
    });

    const creds = await getUserLlmCredentials("u1");

    expect(creds).toEqual({
      anthropicApiKey: "sk-ant-user",
      geminiApiKey: "gem-user",
      quotaScope: "u1",
    });
  });

  it("reads only the BYOK columns it needs (hot path: never the whole row)", async () => {
    findUnique.mockResolvedValue(null);

    await getUserLlmCredentials("u1");

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: {
        anthropicApiKey: true,
        geminiApiKey: true,
        chatModel: true,
        plan: true,
        role: true,
      },
    });
  });

  it("returns null keys for a keyless user (→ shared env, unchanged)", async () => {
    findUnique.mockResolvedValue({ anthropicApiKey: null, geminiApiKey: null });

    const creds = await getUserLlmCredentials("u1");

    expect(creds).toEqual({ anthropicApiKey: null, geminiApiKey: null, quotaScope: "u1" });
  });

  it("ignores a stored key for a non-entitled user but keeps their model choice", async () => {
    isEntitled.mockReturnValue(false);
    findUnique.mockResolvedValue({
      anthropicApiKey: "cipher:sk-ant-user",
      geminiApiKey: "cipher:gem-user",
      chatModel: "claude-sonnet-5",
      plan: "FREE",
      role: "USER",
    });

    const creds = await getUserLlmCredentials("u1");

    // No key and no quotaScope: the call rides the shared env provider.
    expect(creds).toStrictEqual({ userModel: "claude-sonnet-5" });
    expect(isEntitled).toHaveBeenCalledWith("FREE", "USER");
    expect(decryptOptional).not.toHaveBeenCalled();
  });

  it("returns {} when the user row does not exist", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getUserLlmCredentials("ghost")).toEqual({});
  });

  it("degrades to {} (not throw) when the DB lookup fails, and signals", async () => {
    findUnique.mockRejectedValue(new Error("db connection reset"));

    const creds = await getUserLlmCredentials("u1");

    expect(creds).toEqual({});
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "byok.lookup" } }),
    );
  });

  it("degrades a corrupt key to null (not throw), preserving the other key, and signals", async () => {
    findUnique.mockResolvedValue({
      anthropicApiKey: "corrupt",
      geminiApiKey: "cipher:gem-ok",
    });
    decryptOptional.mockImplementation((v: string | null | undefined) => {
      if (v === "corrupt") throw new Error("Refusing to use a non-v1 token");
      return v ? String(v).replace("cipher:", "") : null;
    });

    const creds = await getUserLlmCredentials("u1");

    expect(creds).toEqual({
      anthropicApiKey: null,
      geminiApiKey: "gem-ok",
      quotaScope: "u1",
    });
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "byok.decrypt" } }),
    );
  });

  it("sets userModel for a curated chatModel even WITHOUT a BYOK key (choice is for everyone)", async () => {
    findUnique.mockResolvedValue({
      anthropicApiKey: null,
      geminiApiKey: null,
      chatModel: "claude-sonnet-5",
    });
    const creds = await getUserLlmCredentials("u1");
    expect(creds.userModel).toBe("claude-sonnet-5");
  });

  it("leaves userModel undefined when chatModel is not curated", async () => {
    for (const chatModel of ["google/gemma-4-31b-it:free", "anthropic/claude-sonnet-5"]) {
      findUnique.mockResolvedValue({
        anthropicApiKey: "cipher:sk-ant",
        geminiApiKey: null,
        chatModel,
      });
      const creds = await getUserLlmCredentials("u1");
      expect(creds.userModel, chatModel).toBeUndefined();
    }
  });
});
