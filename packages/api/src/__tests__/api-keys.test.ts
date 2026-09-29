/**
 * API keys — the machine credential for the MCP endpoint, and nothing else:
 * requireAuth/getUserId never accept one, and authenticateApiKey is called
 * only by the MCP route, so a leaked key's blast radius is the MCP toolset,
 * not the account. Only the SHA-256 hash is stored (Device.tokenHash /
 * one-time-token standard); the raw key is shown once at creation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keyFindUnique = vi.hoisted(() => vi.fn(async () => null as unknown));
const keyUpdate = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../db.js", () => {
  const prisma = { apiKey: { findUnique: keyFindUnique, update: keyUpdate } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { mcpWriteToolsEnabled } from "../config.js";
import { authenticateApiKey, hashApiKey, mintApiKey } from "../mcp/api-keys.js";

const ORIGINAL_WRITE_FLAG = process.env.MCP_WRITE_TOOLS_ENABLED;

beforeEach(() => {
  delete process.env.MCP_WRITE_TOOLS_ENABLED;
  keyFindUnique.mockReset();
  keyFindUnique.mockResolvedValue(null);
  keyUpdate.mockClear();
});

afterEach(() => {
  if (ORIGINAL_WRITE_FLAG === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
  else process.env.MCP_WRITE_TOOLS_ENABLED = ORIGINAL_WRITE_FLAG;
});

describe("mintApiKey", () => {
  it("mints a prefixed secret, stores only its hash, and keeps a display prefix", () => {
    const minted = mintApiKey();
    expect(minted.token).toMatch(/^klorn_sk_[0-9a-f]{64}$/);
    expect(minted.tokenHash).toBe(hashApiKey(minted.token));
    expect(minted.tokenHash).not.toContain(minted.token.slice(9));
    expect(minted.prefix).toBe(minted.token.slice(0, 15));
  });

  it("mints unique secrets", () => {
    expect(mintApiKey().token).not.toBe(mintApiKey().token);
  });
});

describe("authenticateApiKey", () => {
  it("resolves a live key to its user and bumps lastUsedAt", async () => {
    const minted = mintApiKey();
    keyFindUnique.mockResolvedValue({
      id: "k1",
      userId: "u1",
      permission: "read",
      revokedAt: null,
    });
    const out = await authenticateApiKey(`Bearer ${minted.token}`);
    expect(out).toEqual({ userId: "u1", keyId: "k1", permission: "read" });
    expect(keyFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { keyHash: hashApiKey(minted.token) } }),
    );
    await vi.waitFor(() => expect(keyUpdate).toHaveBeenCalled());
  });

  it("rejects a revoked key", async () => {
    keyFindUnique.mockResolvedValue({
      id: "k1",
      userId: "u1",
      revokedAt: new Date("2026-08-01T00:00:00Z"),
    });
    expect(await authenticateApiKey(`Bearer ${mintApiKey().token}`)).toBeNull();
  });

  it("rejects unknown, malformed, or non-key bearers without a DB hit", async () => {
    expect(await authenticateApiKey(undefined)).toBeNull();
    expect(await authenticateApiKey("Bearer eyJhbGciOi.jwt.token")).toBeNull();
    expect(await authenticateApiKey("Basic abc")).toBeNull();
    expect(keyFindUnique).not.toHaveBeenCalled();
    expect(await authenticateApiKey(`Bearer ${mintApiKey().token}`)).toBeNull();
  });
});

describe("lastUsedAt throttle", () => {
  it("skips the bump when lastUsedAt is fresh (per-request write amplification)", async () => {
    const minted = mintApiKey();
    keyFindUnique.mockResolvedValue({
      id: "k1",
      userId: "u1",
      permission: "read",
      revokedAt: null,
      lastUsedAt: new Date(),
    });
    expect(await authenticateApiKey(`Bearer ${minted.token}`)).toEqual({
      userId: "u1",
      keyId: "k1",
      permission: "read",
    });
    expect(keyUpdate).not.toHaveBeenCalled();
  });
});

describe("lastUsedAt throttle — stale branch", () => {
  it("bumps when lastUsedAt is older than the throttle window", async () => {
    const minted = mintApiKey();
    keyFindUnique.mockResolvedValue({
      id: "k1",
      userId: "u1",
      revokedAt: null,
      lastUsedAt: new Date(Date.now() - 6 * 60_000),
    });
    await authenticateApiKey(`Bearer ${minted.token}`);
    await vi.waitFor(() => expect(keyUpdate).toHaveBeenCalledTimes(1));
  });
});

describe("authenticateApiKey — effective permission", () => {
  const stored = (permission: unknown) => ({
    id: "k1",
    userId: "u1",
    permission,
    revokedAt: null,
  });
  const authenticate = () => authenticateApiKey(`Bearer ${mintApiKey().token}`);

  it("asks the database for the key's stored permission", async () => {
    keyFindUnique.mockResolvedValue(stored("read"));
    await authenticate();
    expect(keyFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ permission: true }) }),
    );
  });

  it("returns read for a read key, whatever the flag", async () => {
    keyFindUnique.mockResolvedValue(stored("read"));
    for (const flag of [undefined, "true"]) {
      if (flag === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
      else process.env.MCP_WRITE_TOOLS_ENABLED = flag;
      expect(await authenticate()).toEqual({ userId: "u1", keyId: "k1", permission: "read" });
    }
  });

  it("returns read_write for a stored read_write key while the flag is ON", async () => {
    process.env.MCP_WRITE_TOOLS_ENABLED = "true";
    keyFindUnique.mockResolvedValue(stored("read_write"));
    expect(await authenticate()).toEqual({ userId: "u1", keyId: "k1", permission: "read_write" });
  });

  it("acts as read for a stored read_write key while the flag is OFF", async () => {
    keyFindUnique.mockResolvedValue(stored("read_write"));
    expect(await authenticate()).toEqual({ userId: "u1", keyId: "k1", permission: "read" });
  });

  it("follows the flag per call: read, then read_write, then read again", async () => {
    keyFindUnique.mockResolvedValue(stored("read_write"));
    const seen: Array<string | undefined> = [];
    for (const flag of [undefined, "true", "false"]) {
      if (flag === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
      else process.env.MCP_WRITE_TOOLS_ENABLED = flag;
      seen.push((await authenticate())?.permission);
    }
    expect(seen).toEqual(["read", "read_write", "read"]);
  });

  it("fails closed to read for a missing or unrecognised stored value, even with the flag ON", async () => {
    process.env.MCP_WRITE_TOOLS_ENABLED = "true";
    for (const permission of [undefined, null, "admin", "READ_WRITE", "", 1]) {
      keyFindUnique.mockResolvedValue(stored(permission));
      expect((await authenticate())?.permission, `stored=${String(permission)}`).toBe("read");
    }
  });

  it("still rejects a revoked read-write key, flag ON or OFF", async () => {
    keyFindUnique.mockResolvedValue({
      ...stored("read_write"),
      revokedAt: new Date("2026-08-01T00:00:00Z"),
    });
    for (const flag of [undefined, "true"]) {
      if (flag === undefined) delete process.env.MCP_WRITE_TOOLS_ENABLED;
      else process.env.MCP_WRITE_TOOLS_ENABLED = flag;
      expect(await authenticate()).toBeNull();
    }
  });
});

describe("mcpWriteToolsEnabled", () => {
  it("is OFF by default", () => {
    delete process.env.MCP_WRITE_TOOLS_ENABLED;
    expect(mcpWriteToolsEnabled()).toBe(false);
  });

  it("stays OFF for falsy and unrecognised values", () => {
    for (const raw of ["", "false", "0", "no", "off", "enabled", "2"]) {
      process.env.MCP_WRITE_TOOLS_ENABLED = raw;
      expect(mcpWriteToolsEnabled(), `raw=${JSON.stringify(raw)}`).toBe(false);
    }
  });

  it("turns ON with the lenient truthy parse (case and whitespace tolerant)", () => {
    for (const raw of ["true", "1", "yes", "on", "TRUE", " On ", "Yes"]) {
      process.env.MCP_WRITE_TOOLS_ENABLED = raw;
      expect(mcpWriteToolsEnabled(), `raw=${JSON.stringify(raw)}`).toBe(true);
    }
  });

  it("is read at request time, not import time", () => {
    delete process.env.MCP_WRITE_TOOLS_ENABLED;
    expect(mcpWriteToolsEnabled()).toBe(false);
    process.env.MCP_WRITE_TOOLS_ENABLED = "true";
    expect(mcpWriteToolsEnabled()).toBe(true);
    process.env.MCP_WRITE_TOOLS_ENABLED = "false";
    expect(mcpWriteToolsEnabled()).toBe(false);
  });
});
