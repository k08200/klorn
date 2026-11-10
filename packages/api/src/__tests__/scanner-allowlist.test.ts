import { afterEach, describe, expect, it, vi } from "vitest";

import { isRateLimitAllowedIp, parseAllowedCidrs } from "../security/scanner-allowlist.js";

/**
 * A CASA DAST scan fires thousands of requests from a handful of source IPs.
 * Measured against production on 2026-08-12: 60 sequential requests from one
 * address already drew 11× 429. Unthrottled, the assessor's scan comes back
 * incomplete and burns a revalidation cycle.
 *
 * So the limiter needs a narrow, env-driven exemption — empty by default, held
 * open only for the scan window.
 */
describe("scanner allow-list", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows nothing when the env var is unset — the default must not change", () => {
    expect(parseAllowedCidrs(undefined)).toEqual([]);
    expect(isRateLimitAllowedIp("203.0.113.9", [])).toBe(false);
  });

  it("allows nothing for an empty or whitespace value", () => {
    expect(parseAllowedCidrs("")).toEqual([]);
    expect(parseAllowedCidrs("  ,  , ")).toEqual([]);
  });

  it("matches a bare IPv4 address exactly", () => {
    const rules = parseAllowedCidrs("203.0.113.9");
    expect(isRateLimitAllowedIp("203.0.113.9", rules)).toBe(true);
    expect(isRateLimitAllowedIp("203.0.113.10", rules)).toBe(false);
  });

  it("matches inside a CIDR range and rejects outside it", () => {
    const rules = parseAllowedCidrs("198.51.100.0/24");
    expect(isRateLimitAllowedIp("198.51.100.1", rules)).toBe(true);
    expect(isRateLimitAllowedIp("198.51.100.255", rules)).toBe(true);
    expect(isRateLimitAllowedIp("198.51.101.1", rules)).toBe(false);
  });

  it("handles a /32 and a comma-separated mix", () => {
    const rules = parseAllowedCidrs("203.0.113.9/32, 198.51.100.0/24 ,192.0.2.7");
    expect(rules).toHaveLength(3);
    expect(isRateLimitAllowedIp("203.0.113.9", rules)).toBe(true);
    expect(isRateLimitAllowedIp("198.51.100.42", rules)).toBe(true);
    expect(isRateLimitAllowedIp("192.0.2.7", rules)).toBe(true);
    expect(isRateLimitAllowedIp("192.0.2.8", rules)).toBe(false);
  });

  it("never opens up on a malformed rule — a typo must fail closed, not wide", () => {
    // A bad prefix here would be catastrophic: /0 matches the entire internet.
    expect(parseAllowedCidrs("not-an-ip")).toEqual([]);
    expect(parseAllowedCidrs("198.51.100.0/33")).toEqual([]);
    expect(parseAllowedCidrs("198.51.100.0/0")).toEqual([]);
    expect(parseAllowedCidrs("999.1.1.1")).toEqual([]);
    expect(isRateLimitAllowedIp("8.8.8.8", parseAllowedCidrs("0.0.0.0/0"))).toBe(false);
  });

  it("ignores IPv6 and unparseable client addresses rather than throwing", () => {
    const rules = parseAllowedCidrs("198.51.100.0/24");
    expect(isRateLimitAllowedIp("2001:db8::1", rules)).toBe(false);
    expect(isRateLimitAllowedIp("", rules)).toBe(false);
    expect(isRateLimitAllowedIp(undefined, rules)).toBe(false);
  });
});
