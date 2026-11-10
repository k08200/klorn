/**
 * Step B4, design D2: the default resolver asks DNS directly (c-ares, through
 * `node:dns` Resolver), never `dns.lookup`, so neither /etc/hosts nor search
 * domains can make a name mean something Klorn did not check. A and AAAA are both
 * asked, IPv4 answers come first, and a per-query timeout bounds a stalling server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  ctor: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor(options: unknown) {
      dnsMock.ctor(options);
    }
    resolve4 = dnsMock.resolve4;
    resolve6 = dnsMock.resolve6;
  },
  lookup: dnsMock.lookup,
  default: { lookup: dnsMock.lookup },
}));

const { DNS_QUERY_TIMEOUT_MS, resolveHostAddresses } = await import("../mail/host-resolver.js");

const noData = () => Object.assign(new Error("queryAaaa ENODATA"), { code: "ENODATA" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveHostAddresses", () => {
  it("returns the A answers before the AAAA answers", async () => {
    dnsMock.resolve4.mockResolvedValue(["93.184.216.34", "8.8.8.8"]);
    dnsMock.resolve6.mockResolvedValue(["2606:4700:4700::1111"]);
    await expect(resolveHostAddresses("imap.example.com")).resolves.toEqual([
      "93.184.216.34",
      "8.8.8.8",
      "2606:4700:4700::1111",
    ]);
    expect(dnsMock.resolve4).toHaveBeenCalledWith("imap.example.com");
    expect(dnsMock.resolve6).toHaveBeenCalledWith("imap.example.com");
  });

  it("returns what one family answers when the other has no data", async () => {
    dnsMock.resolve4.mockResolvedValue(["93.184.216.34"]);
    dnsMock.resolve6.mockRejectedValue(noData());
    await expect(resolveHostAddresses("imap.example.com")).resolves.toEqual(["93.184.216.34"]);

    dnsMock.resolve4.mockRejectedValue(noData());
    dnsMock.resolve6.mockResolvedValue(["2606:4700:4700::1111"]);
    await expect(resolveHostAddresses("imap.example.com")).resolves.toEqual([
      "2606:4700:4700::1111",
    ]);
  });

  it("throws when both families fail", async () => {
    dnsMock.resolve4.mockRejectedValue(
      Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    dnsMock.resolve6.mockRejectedValue(noData());
    await expect(resolveHostAddresses("nope.example.com")).rejects.toThrow();
  });

  it("returns an empty list when both families answer with nothing", async () => {
    dnsMock.resolve4.mockResolvedValue([]);
    dnsMock.resolve6.mockResolvedValue([]);
    await expect(resolveHostAddresses("imap.example.com")).resolves.toEqual([]);
  });

  it("asks DNS directly with a bounded timeout and never calls dns.lookup", async () => {
    dnsMock.resolve4.mockResolvedValue(["93.184.216.34"]);
    dnsMock.resolve6.mockResolvedValue([]);
    await resolveHostAddresses("imap.example.com");
    expect(dnsMock.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: DNS_QUERY_TIMEOUT_MS }),
    );
    expect(DNS_QUERY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DNS_QUERY_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(dnsMock.lookup).not.toHaveBeenCalled();
  });
});
