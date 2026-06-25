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

vi.mock("../db.js", () => ({ prisma: { user: { findUnique } }, db: {} }));
vi.mock("../crypto-tokens.js", () => ({ decryptOptional }));
vi.mock("../sentry.js", () => ({ captureError }));

import { getUserLlmCredentials } from "../llm-credentials.js";

beforeEach(() => {
  findUnique.mockReset();
  decryptOptional.mockReset();
  captureError.mockReset();
  // Default: decrypt is identity on a "cipher:" prefix, null otherwise.
  decryptOptional.mockImplementation((v: string | null | undefined) =>
    v ? String(v).replace("cipher:", "") : null,
  );
});

describe("getUserLlmCredentials", () => {
  it("returns decrypted per-user keys when set", async () => {
    findUnique.mockResolvedValue({
      openRouterApiKey: "cipher:sk-or-user",
      geminiApiKey: "cipher:gem-user",
    });

    const creds = await getUserLlmCredentials("u1");

    expect(creds).toEqual({
      openRouterApiKey: "sk-or-user",
      geminiApiKey: "gem-user",
      quotaScope: "u1",
    });
  });

  it("returns null keys for a keyless user (→ shared env, unchanged)", async () => {
    findUnique.mockResolvedValue({ openRouterApiKey: null, geminiApiKey: null });

    const creds = await getUserLlmCredentials("u1");

    expect(creds).toEqual({ openRouterApiKey: null, geminiApiKey: null, quotaScope: "u1" });
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
      openRouterApiKey: "corrupt",
      geminiApiKey: "cipher:gem-ok",
    });
    decryptOptional.mockImplementation((v: string | null | undefined) => {
      if (v === "corrupt") throw new Error("Refusing to use a non-v1 token");
      return v ? String(v).replace("cipher:", "") : null;
    });

    const creds = await getUserLlmCredentials("u1");

    expect(creds).toEqual({
      openRouterApiKey: null,
      geminiApiKey: "gem-ok",
      quotaScope: "u1",
    });
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "byok.decrypt" } }),
    );
  });

  it("sets userModel when the user has a BYOK key and a curated chatModel", async () => {
    findUnique.mockResolvedValue({ openRouterApiKey: "cipher:sk-or", geminiApiKey: null, chatModel: "openai/gpt-4o" });
    const creds = await getUserLlmCredentials("u1");
    expect(creds.userModel).toBe("openai/gpt-4o");
  });

  it("leaves userModel undefined when the user has no key (keyless keeps defaults)", async () => {
    findUnique.mockResolvedValue({ openRouterApiKey: null, geminiApiKey: null, chatModel: "openai/gpt-4o" });
    const creds = await getUserLlmCredentials("u1");
    expect(creds.userModel).toBeUndefined();
  });

  it("leaves userModel undefined when chatModel is not curated", async () => {
    findUnique.mockResolvedValue({ openRouterApiKey: "cipher:sk-or", geminiApiKey: null, chatModel: "google/gemma-4-31b-it:free" });
    const creds = await getUserLlmCredentials("u1");
    expect(creds.userModel).toBeUndefined();
  });
});
