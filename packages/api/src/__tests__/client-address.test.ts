/**
 * The client address every per-address decision keys on (rate limits, the
 * scan exemption, device-session records). A header is trusted only when the
 * deployment says which one its ingress writes; the default is the TCP peer,
 * which a client cannot choose.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clientAddress,
  clientAddressBucket,
  deriveClientAddress,
  describeClientAddressConfig,
  resolveClientAddressConfig,
} from "../security/client-address.js";

type Headers = Record<string, string | string[] | undefined>;

function req(headers: Headers, remoteAddress: string | undefined = "10.0.0.1") {
  return { headers, socket: { remoteAddress } };
}

const SOCKET = { source: "socket", trustedProxyHops: 1 } as const;
const CLOUDFLARE = { source: "cf-connecting-ip", trustedProxyHops: 1 } as const;
const XFF_ONE_HOP = { source: "x-forwarded-for", trustedProxyHops: 1 } as const;
const XFF_TWO_HOPS = { source: "x-forwarded-for", trustedProxyHops: 2 } as const;

describe("resolveClientAddressConfig", () => {
  it("defaults to the TCP peer when nothing is configured (self-host)", () => {
    expect(resolveClientAddressConfig({})).toEqual(SOCKET);
  });

  it("treats an empty value as unset (compose passes ${VAR:-})", () => {
    expect(resolveClientAddressConfig({ CLIENT_IP_SOURCE: "", TRUSTED_PROXY_HOPS: "" })).toEqual(
      SOCKET,
    );
  });

  it("defaults to CF-Connecting-IP on Render, whose edge rejects a client-sent copy", () => {
    expect(resolveClientAddressConfig({ RENDER: "true" })).toEqual(CLOUDFLARE);
  });

  it("lets an explicit source win over the Render default", () => {
    expect(resolveClientAddressConfig({ RENDER: "true", CLIENT_IP_SOURCE: "socket" })).toEqual(
      SOCKET,
    );
  });

  it("reads x-forwarded-for with a hop count, case- and whitespace-insensitive", () => {
    expect(
      resolveClientAddressConfig({
        CLIENT_IP_SOURCE: " X-Forwarded-For ",
        TRUSTED_PROXY_HOPS: "2",
      }),
    ).toEqual(XFF_TWO_HOPS);
  });

  it("refuses an unknown source instead of guessing", () => {
    expect(() => resolveClientAddressConfig({ CLIENT_IP_SOURCE: "x-real-ip" })).toThrow(
      /CLIENT_IP_SOURCE/,
    );
  });

  it("ignores TRUSTED_PROXY_HOPS when the source does not use it", () => {
    expect(resolveClientAddressConfig({ TRUSTED_PROXY_HOPS: "abc" })).toEqual(SOCKET);
  });

  it.each(["0", "-1", "1.5", "abc", "11"])("refuses TRUSTED_PROXY_HOPS=%s", (hops) => {
    expect(() =>
      resolveClientAddressConfig({ CLIENT_IP_SOURCE: "x-forwarded-for", TRUSTED_PROXY_HOPS: hops }),
    ).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});

describe("deriveClientAddress — socket (the default)", () => {
  it("ignores a client-sent CF-Connecting-IP and X-Forwarded-For", () => {
    const spoofed = req({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.1",
    });
    expect(deriveClientAddress(spoofed, SOCKET)).toBe("10.0.0.1");
  });

  it("unwraps an IPv4-mapped IPv6 peer so keys and the exemption see one form", () => {
    expect(deriveClientAddress(req({}, "::ffff:192.0.2.10"), SOCKET)).toBe("192.0.2.10");
  });

  it("keeps a plain IPv6 peer, lowercased so one host is one key", () => {
    expect(deriveClientAddress(req({}, "2001:DB8::1"), SOCKET)).toBe("2001:db8::1");
  });

  it("returns a fixed marker when the socket has no address", () => {
    expect(deriveClientAddress({ headers: {} }, SOCKET)).toBe("unknown");
  });
});

describe("deriveClientAddress — cf-connecting-ip", () => {
  it("uses the header and ignores X-Forwarded-For", () => {
    const viaEdge = req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" });
    expect(deriveClientAddress(viaEdge, CLOUDFLARE)).toBe("203.0.113.7");
  });

  it("gives distinct clients distinct addresses", () => {
    const a = deriveClientAddress(req({ "cf-connecting-ip": "203.0.113.7" }), CLOUDFLARE);
    const b = deriveClientAddress(req({ "cf-connecting-ip": "203.0.113.8" }), CLOUDFLARE);
    expect(a).not.toBe(b);
  });

  it.each([
    ["absent", {}],
    ["empty", { "cf-connecting-ip": "" }],
    ["not an address", { "cf-connecting-ip": "evil" }],
    ["a list", { "cf-connecting-ip": "203.0.113.7, 203.0.113.8" }],
    ["repeated", { "cf-connecting-ip": ["203.0.113.7", "203.0.113.8"] }],
    ["an address with a zone id", { "cf-connecting-ip": `fe80::1%${"a".repeat(64)}` }],
  ] as const)("falls back to the peer when the header is %s", (_label, headers) => {
    expect(deriveClientAddress(req(headers as Headers), CLOUDFLARE)).toBe("10.0.0.1");
  });
});

describe("deriveClientAddress — x-forwarded-for", () => {
  it("takes the entry the trusted proxy appended, not what the client prepended", () => {
    const forged = req({ "x-forwarded-for": "198.51.100.1, 192.0.2.44" });
    expect(deriveClientAddress(forged, XFF_ONE_HOP)).toBe("192.0.2.44");
  });

  it("ignores CF-Connecting-IP in this mode", () => {
    const forged = req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "192.0.2.44" });
    expect(deriveClientAddress(forged, XFF_ONE_HOP)).toBe("192.0.2.44");
  });

  it("counts hops from the right for a proxy behind a load balancer", () => {
    const chain = req({ "x-forwarded-for": "198.51.100.1, 192.0.2.44, 10.0.0.9" });
    expect(deriveClientAddress(chain, XFF_TWO_HOPS)).toBe("192.0.2.44");
  });

  it("reads repeated headers as one list", () => {
    const repeated = req({ "x-forwarded-for": ["198.51.100.1", "192.0.2.44"] });
    expect(deriveClientAddress(repeated, XFF_ONE_HOP)).toBe("192.0.2.44");
  });

  it("falls back to the peer when the chain is shorter than the hop count", () => {
    expect(deriveClientAddress(req({ "x-forwarded-for": "192.0.2.44" }), XFF_TWO_HOPS)).toBe(
      "10.0.0.1",
    );
    expect(deriveClientAddress(req({}), XFF_ONE_HOP)).toBe("10.0.0.1");
  });

  it("falls back to the peer when the selected entry is not an address", () => {
    expect(
      deriveClientAddress(req({ "x-forwarded-for": "192.0.2.44, garbage" }), XFF_ONE_HOP),
    ).toBe("10.0.0.1");
  });
});

describe("clientAddressBucket", () => {
  const CF_ENV = { CLIENT_IP_SOURCE: "cf-connecting-ip" } as const;

  function viaEdge(ip: string) {
    return req({ "cf-connecting-ip": ip });
  }

  it("groups an IPv6 client by its /64, the unit an address is allocated in", () => {
    const one = clientAddressBucket(viaEdge("2001:db8:1234:5678::1"), CF_ENV);
    const other = clientAddressBucket(viaEdge("2001:db8:1234:5678::dead:beef"), CF_ENV);
    expect(one).toBe(other);
    expect(one).toBe("2001:db8:1234:5678");
  });

  it("keeps a different /64 in a different bucket", () => {
    const a = clientAddressBucket(viaEdge("2001:db8:1234:5678::1"), CF_ENV);
    const b = clientAddressBucket(viaEdge("2001:db8:1234:5679::1"), CF_ENV);
    expect(a).not.toBe(b);
  });

  it("writes one bucket for a /64 however the address is abbreviated", () => {
    // Same /64, three spellings: zero-compressed, zero-padded, upper case.
    const compressed = clientAddressBucket(viaEdge("2001:db8::1"), CF_ENV);
    const padded = clientAddressBucket(viaEdge("2001:0db8:0000:0000:0000:0000:0000:0001"), CF_ENV);
    const upper = clientAddressBucket(viaEdge("2001:DB8::2"), CF_ENV);
    expect(compressed).toBe("2001:db8:0:0");
    expect(padded).toBe(compressed);
    expect(upper).toBe(compressed);
  });

  it.each([
    ["a leading run of zero groups", "::1", "0:0:0:0"],
    ["a trailing run of zero groups", "fe80::", "fe80:0:0:0"],
    ["a full eight-group address", "2001:db8:1:2:3:4:5:6", "2001:db8:1:2"],
    ["a run that ends inside the prefix", "2001::1:5:6:7:8", "2001:0:0:1"],
    ["a dotted-quad tail after a run", "2001:db8:1::5:1.2.3.4", "2001:db8:1:0"],
  ] as const)("handles %s", (_label, address, bucket) => {
    expect(clientAddressBucket(viaEdge(address), CF_ENV)).toBe(bucket);
  });

  it("finds the /64 when `::` stops short of it", () => {
    // RFC 5952 writes 2001:0:0:1:5:6:7:8 as 2001::1:5:6:7:8: the elided run
    // ends inside the prefix, so the prefix's last group comes after `::`.
    // Read as zero, one /64 split into two buckets (twice the quota) and
    // neighbouring /64s merged into one.
    const longInterfaceId = clientAddressBucket(viaEdge("2001::1:5:6:7:8"), CF_ENV);
    const shortInterfaceId = clientAddressBucket(viaEdge("2001:0:0:1::1"), CF_ENV);
    expect(longInterfaceId).toBe(shortInterfaceId);
    expect(clientAddressBucket(viaEdge("2001::2:5:6:7:8"), CF_ENV)).not.toBe(longInterfaceId);
  });

  it("leaves an IPv4 client keyed on its own address", () => {
    // One IPv4 address is one host; grouping would punish a shared NAT.
    expect(clientAddressBucket(viaEdge("203.0.113.7"), CF_ENV)).toBe("203.0.113.7");
    expect(clientAddressBucket(viaEdge("::ffff:203.0.113.7"), CF_ENV)).toBe("203.0.113.7");
  });

  it("passes the unknown marker through instead of bucketing it", () => {
    expect(clientAddressBucket({ headers: {} }, { CLIENT_IP_SOURCE: "socket" })).toBe("unknown");
  });

  it("reads the same configured source as clientAddress", () => {
    // A client-sent header must not pick the bucket either.
    const spoofed = req({ "cf-connecting-ip": "2001:db8:aaaa:bbbb::1" }, "2001:db8:1:2::9");
    expect(clientAddressBucket(spoofed, { CLIENT_IP_SOURCE: "socket" })).toBe("2001:db8:1:2");
  });
});

describe("guard: one place derives the client address", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  const HELPER = join(SRC, "security", "client-address.ts");
  // A header read or request.ip outside the helper reintroduces a forgeable source.
  const HEADER = String.raw`["'\`](?:cf-connecting-ip|x-forwarded-for|x-real-ip|forwarded|true-client-ip|x-client-ip|x-cluster-client-ip|fastly-client-ip)["'\`]`;
  const FORBIDDEN = [
    new RegExp(String.raw`\[\s*${HEADER}\s*\]`, "i"), // headers["…"]
    new RegExp(String.raw`${HEADER}\s*:`, "i"), // const { "…": v } = headers
    new RegExp(String.raw`\.get\(\s*${HEADER}`, "i"), // headers.get("…")
    /\b(?:request|req)\.ips?\b/,
    /\.remoteAddress\b/, // the raw peer, which the helper normalizes
  ];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  }

  it("no source file outside security/client-address.ts reads a client-address header or request.ip", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => path !== HELPER)
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .filter(({ line }) => FORBIDDEN.some((pattern) => pattern.test(line)))
          .map(({ index }) => `${relative(SRC, path)}:${index + 1}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe("describeClientAddressConfig", () => {
  it("names the hop count only where it applies", () => {
    expect(describeClientAddressConfig(SOCKET)).toBe("source=socket");
    expect(describeClientAddressConfig(XFF_TWO_HOPS)).toBe(
      "source=x-forwarded-for trustedProxyHops=2",
    );
  });
});

describe("clientAddress", () => {
  it("resolves the configuration from the given environment", () => {
    const viaEdge = req({ "cf-connecting-ip": "203.0.113.7" });
    expect(clientAddress(viaEdge, {})).toBe("10.0.0.1");
    expect(clientAddress(viaEdge, { CLIENT_IP_SOURCE: "cf-connecting-ip" })).toBe("203.0.113.7");
  });
});
