/**
 * Step B4, design D2: resolve-then-pin. Klorn resolves the name itself and refuses
 * it when there is no answer or when ANY answer is non-public; one checked address
 * is pinned. Nothing is cached, so every call sees what DNS says now (a name that
 * turns private after an earlier check is refused the next time).
 */

import { describe, expect, it, vi } from "vitest";

import { PinnedAddressError, resolvePinnedAddress } from "../mail/pinned-address.js";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V4_B = "8.8.8.8";
const PUBLIC_V6 = "2606:4700:4700::1111";

const resolverOf = (...answers: string[]) => vi.fn(async () => answers);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PinnedAddressError) return err.code;
    throw err;
  }
  return "resolved";
}

describe("resolvePinnedAddress: what it pins", () => {
  it("pins the one public IPv4 address", async () => {
    await expect(resolvePinnedAddress("imap.example.com", resolverOf(PUBLIC_V4))).resolves.toEqual({
      address: PUBLIC_V4,
      family: 4,
    });
  });

  it("pins an IPv6 address when that is all there is", async () => {
    await expect(resolvePinnedAddress("imap.example.com", resolverOf(PUBLIC_V6))).resolves.toEqual({
      address: PUBLIC_V6,
      family: 6,
    });
  });

  it("prefers the first IPv4 address whatever the order of the answers", async () => {
    await expect(
      resolvePinnedAddress("imap.example.com", resolverOf(PUBLIC_V6, PUBLIC_V4, PUBLIC_V4_B)),
    ).resolves.toEqual({ address: PUBLIC_V4, family: 4 });
  });

  it("asks the resolver for exactly the name it was given", async () => {
    const resolver = resolverOf(PUBLIC_V4);
    await resolvePinnedAddress("imap.example.com", resolver);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("imap.example.com");
  });
});

const NON_PUBLIC: ReadonlyArray<string> = [
  "10.0.0.1",
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",
  "100.64.0.1",
  "172.16.5.5",
  "192.168.0.10",
  "::1",
  "fc00::1",
  "fd00:ec2::254",
  "fe80::1",
  "::ffff:10.0.0.1",
  "::ffff:127.0.0.1",
  "224.0.0.1",
  "240.0.0.1",
  "not-an-address",
];

describe("resolvePinnedAddress: any non-public answer refuses the name", () => {
  it.each(NON_PUBLIC)("a lone %s is refused", async (bad) => {
    expect(await codeOf(resolvePinnedAddress("imap.example.com", resolverOf(bad)))).toBe(
      "blocked-address",
    );
  });

  it.each(NON_PUBLIC)("%s mixed in AFTER a public address refuses the whole name", async (bad) => {
    expect(await codeOf(resolvePinnedAddress("imap.example.com", resolverOf(PUBLIC_V4, bad)))).toBe(
      "blocked-address",
    );
  });

  it.each(NON_PUBLIC)("%s mixed in BEFORE a public address refuses the whole name", async (bad) => {
    expect(await codeOf(resolvePinnedAddress("imap.example.com", resolverOf(bad, PUBLIC_V4)))).toBe(
      "blocked-address",
    );
  });

  it("refuses a public IPv4 answer next to a private IPv6 answer", async () => {
    expect(
      await codeOf(resolvePinnedAddress("imap.example.com", resolverOf(PUBLIC_V4, "fd00::1"))),
    ).toBe("blocked-address");
  });

  it("refuses when the only private answer is among many public ones", async () => {
    expect(
      await codeOf(
        resolvePinnedAddress(
          "imap.example.com",
          resolverOf(PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V6, "10.1.2.3", "1.1.1.1"),
        ),
      ),
    ).toBe("blocked-address");
  });
});

describe("resolvePinnedAddress: nothing to pin", () => {
  it("refuses a name with no answers", async () => {
    expect(await codeOf(resolvePinnedAddress("imap.example.com", resolverOf()))).toBe(
      "unresolvable",
    );
  });

  it("refuses a name whose resolution fails", async () => {
    const resolver = vi.fn(async () => {
      throw Object.assign(new Error("queryA ENOTFOUND imap.example.com"), { code: "ENOTFOUND" });
    });
    expect(await codeOf(resolvePinnedAddress("imap.example.com", resolver))).toBe("unresolvable");
  });

  it("does not put the library's error text, or any address, in its own message", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("queryA ECONNREFUSED 10.0.0.53:53");
    });
    const err = await resolvePinnedAddress("imap.example.com", resolver).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedAddressError);
    expect((err as Error).message).not.toMatch(/10\.0\.0\.53|ECONNREFUSED/);

    const blocked = await resolvePinnedAddress("imap.example.com", resolverOf("10.9.9.9")).catch(
      (e) => e,
    );
    expect((blocked as Error).message).not.toContain("10.9.9.9");
  });
});

describe("resolvePinnedAddress: the resolver's error code is kept for the log", () => {
  const failing = (error: unknown) =>
    vi.fn(async () => {
      throw error;
    });

  it.each(["ENOTFOUND", "ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"])("keeps %s", async (code) => {
    const err = await resolvePinnedAddress(
      "imap.example.com",
      failing(Object.assign(new Error(`query ${code} 10.0.0.53`), { code })),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PinnedAddressError);
    expect(err.code).toBe("unresolvable");
    expect(err.resolverCode).toBe(code);
    expect(err.message).not.toContain(code);
  });

  it.each([
    ["no code", new Error("x")],
    ["a non-error", "boom"],
    ["a code with a newline", Object.assign(new Error("x"), { code: "E\nFORGED" })],
    ["a lower-case code", Object.assign(new Error("x"), { code: "enotfound" })],
    ["a numeric code", Object.assign(new Error("x"), { code: 53 })],
    ["an over-long code", Object.assign(new Error("x"), { code: "E".repeat(200) })],
  ])("drops %s", async (_label, error) => {
    const err = await resolvePinnedAddress("imap.example.com", failing(error)).catch((e) => e);
    expect(err.code).toBe("unresolvable");
    expect(err.resolverCode).toBeUndefined();
  });

  it("an empty answer and a blocked answer have no resolver code", async () => {
    const empty = await resolvePinnedAddress("imap.example.com", resolverOf()).catch((e) => e);
    const blocked = await resolvePinnedAddress("imap.example.com", resolverOf("10.0.0.1")).catch(
      (e) => e,
    );
    expect(empty.resolverCode).toBeUndefined();
    expect(blocked.resolverCode).toBeUndefined();
  });
});

describe("resolvePinnedAddress: rebinding-safe", () => {
  it("re-resolves on every call: public first, private second is refused the second time", async () => {
    const resolver = vi
      .fn<(host: string) => Promise<string[]>>()
      .mockResolvedValueOnce([PUBLIC_V4])
      .mockResolvedValueOnce(["10.0.0.5"]);

    await expect(resolvePinnedAddress("rebind.example.com", resolver)).resolves.toEqual({
      address: PUBLIC_V4,
      family: 4,
    });
    expect(await codeOf(resolvePinnedAddress("rebind.example.com", resolver))).toBe(
      "blocked-address",
    );
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("does not cache: three calls, three resolutions", async () => {
    const resolver = resolverOf(PUBLIC_V4);
    await resolvePinnedAddress("imap.example.com", resolver);
    await resolvePinnedAddress("imap.example.com", resolver);
    await resolvePinnedAddress("imap.example.com", resolver);
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("a name that was private and turns public is usable (no sticky block)", async () => {
    const resolver = vi
      .fn<(host: string) => Promise<string[]>>()
      .mockResolvedValueOnce(["10.0.0.5"])
      .mockResolvedValueOnce([PUBLIC_V4]);
    expect(await codeOf(resolvePinnedAddress("imap.example.com", resolver))).toBe(
      "blocked-address",
    );
    await expect(resolvePinnedAddress("imap.example.com", resolver)).resolves.toMatchObject({
      address: PUBLIC_V4,
    });
  });
});
