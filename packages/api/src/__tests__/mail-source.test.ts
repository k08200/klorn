import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tokenFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));
const linkedFindFirst = vi.hoisted(() => vi.fn(async () => null as unknown));

vi.mock("../db.js", () => {
  const prisma = {
    userToken: { findFirst: tokenFindFirst },
    linkedInboxAccount: { findFirst: linkedFindFirst },
  };
  return { prisma, db: prisma };
});

const { hasAnyMailSource } = await import("../mail/mail-source.js");

beforeEach(() => {
  tokenFindFirst.mockReset();
  tokenFindFirst.mockResolvedValue(null);
  linkedFindFirst.mockReset();
  linkedFindFirst.mockResolvedValue(null);
});

describe("hasAnyMailSource", () => {
  it("is false when the user has no Google token and no linked inbox", async () => {
    expect(await hasAnyMailSource("user-1")).toBe(false);
  });

  it("is true with only a Google token", async () => {
    tokenFindFirst.mockResolvedValue({ id: "t1" });
    expect(await hasAnyMailSource("user-1")).toBe(true);
  });

  it("is true with only an IMAP (iCloud / Naver) linked inbox", async () => {
    linkedFindFirst.mockResolvedValue({ id: "li-icloud" });
    expect(await hasAnyMailSource("user-1")).toBe(true);
  });

  it("scopes both lookups to the caller, and counts needsReconnect rows (no filter on it)", async () => {
    await hasAnyMailSource("user-7");
    expect(tokenFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-7", provider: "google" },
      select: { id: true },
    });
    expect(linkedFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-7" },
      select: { id: true },
    });
  });

  it("propagates a DB failure instead of silently falling back to demo", async () => {
    linkedFindFirst.mockRejectedValue(new Error("db down"));
    await expect(hasAnyMailSource("user-1")).rejects.toThrow("db down");
  });
});

// Guard: the "no Gmail → fake inbox" bug came from four separate raw
// `provider: "google"` lookups each deciding demo mode. Every demo decision
// must go through hasAnyMailSource; a raw Google-token lookup sitting next to
// demo data in a route is the regression this catches.
describe("demo gate guard", () => {
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
  const WINDOW = 15;

  it("no route decides demo mode from a raw Google-token lookup", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".ts"))) {
      const lines = readFileSync(join(routesDir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes('provider: "google"')) return;
        const after = lines.slice(i, i + WINDOW).join("\n");
        if (/DEMO_|demoRows|source: "demo"/.test(after)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
