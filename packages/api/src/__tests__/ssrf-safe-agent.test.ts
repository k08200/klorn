import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrivateIp } from "../notify/is-safe-push-endpoint.js";
import { ssrfSafeLookup } from "../notify/ssrf-safe-agent.js";

describe("isPrivateIp", () => {
  it("flags loopback / private / link-local / ULA / IPv4-mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "127.0.0.2",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateIp(ip), `${ip} should be private`).toBe(true);
    }
  });

  it("allows real public addresses (FCM/APNs/Mozilla push hosts resolve here)", () => {
    for (const ip of ["8.8.8.8", "142.250.72.1", "17.253.144.10", "2607:f8b0:4004::200e"]) {
      expect(isPrivateIp(ip), `${ip} should be public`).toBe(false);
    }
  });
});

describe("ssrfSafeLookup (connect-time SSRF guard)", () => {
  afterEach(() => vi.restoreAllMocks());

  function runLookup(mockAddresses: dns.LookupAddress[]): Promise<{ err: unknown; addr: unknown }> {
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (e: unknown, a: unknown) => void,
    ) => cb(null, mockAddresses)) as never);
    return new Promise((resolve) => {
      ssrfSafeLookup(
        "host.example",
        { all: false } as never,
        ((err: unknown, addr: unknown) => resolve({ err, addr })) as never,
      );
    });
  }

  it("aborts the connection when the host resolves to a private address", async () => {
    const { err } = await runLookup([{ address: "10.0.0.5", family: 4 }]);
    expect((err as Error | null)?.message).toMatch(/private/i);
  });

  it("aborts when ANY address in a multi-record response is private", async () => {
    const { err } = await runLookup([
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    expect((err as Error | null)?.message).toMatch(/private/i);
  });

  it("passes a public address through unchanged", async () => {
    const { err, addr } = await runLookup([{ address: "8.8.8.8", family: 4 }]);
    expect(err).toBeNull();
    expect(addr).toBe("8.8.8.8");
  });
});
