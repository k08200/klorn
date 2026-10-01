/**
 * Copied with net/ip-policy.ts from feat/generic-imap (B4) for C3; see its header.
 * Step B4: which addresses a user-supplied IMAP host may resolve to. One rule: an
 * address is usable only when it is a public, globally routable unicast address.
 * IPv4 is a deny list of every special-purpose block; IPv6 is default-deny (only
 * 2000::/3 passes, minus the special blocks inside it). Anything that is not a
 * plain address string fails closed.
 */

import { describe, expect, it } from "vitest";

import { isPublicAddress } from "../net/ip-policy.js";

const BLOCKED_V4: ReadonlyArray<readonly [string, string]> = [
  ["0.0.0.0", "this network"],
  ["0.255.255.255", "end of 0/8"],
  ["10.0.0.1", "RFC1918 10/8"],
  ["10.255.255.255", "end of 10/8"],
  ["100.64.0.1", "CGNAT start"],
  ["100.100.100.200", "Alibaba metadata, CGNAT"],
  ["100.127.255.255", "CGNAT end"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "end of loopback"],
  ["169.254.169.254", "cloud metadata"],
  ["169.254.0.1", "link-local"],
  ["172.16.0.1", "RFC1918 172.16/12 start"],
  ["172.31.255.255", "RFC1918 172.16/12 end"],
  ["192.0.0.192", "Oracle metadata, 192.0.0/24"],
  ["192.0.2.1", "TEST-NET-1"],
  ["192.88.99.1", "6to4 relay anycast"],
  ["192.168.1.1", "RFC1918 192.168/16"],
  ["198.18.0.1", "benchmarking start"],
  ["198.19.255.255", "benchmarking end"],
  ["198.51.100.7", "TEST-NET-2"],
  ["203.0.113.9", "TEST-NET-3"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast end"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "broadcast"],
];

const PUBLIC_V4: ReadonlyArray<string> = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "9.255.255.255", // just below 10/8
  "11.0.0.1", // just above 10/8
  "100.63.255.255", // just below CGNAT
  "100.128.0.1", // just above CGNAT
  "126.255.255.255",
  "128.0.0.1",
  "169.253.255.255",
  "169.255.0.1",
  "172.15.255.255", // just below 172.16/12
  "172.32.0.1", // just above 172.16/12
  "192.0.1.1", // between 192.0.0/24 and 192.0.2/24
  "192.167.255.255",
  "192.169.0.1",
  "198.17.255.255",
  "198.20.0.1",
  "223.255.255.255",
];

const BLOCKED_V6: ReadonlyArray<readonly [string, string]> = [
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["::10.0.0.1", "IPv4-compatible"],
  ["fc00::1", "unique local start"],
  ["fd00:ec2::254", "AWS IPv6 metadata"],
  ["FD00:EC2::254", "AWS IPv6 metadata, upper case"],
  ["fdff:ffff::1", "unique local end"],
  ["fe80::1", "link-local"],
  ["febf::1", "link-local end"],
  ["fec0::1", "site-local"],
  ["ff02::1", "multicast"],
  ["64:ff9b::a00:1", "NAT64 of 10.0.0.1"],
  ["64:ff9b::10.0.0.1", "NAT64 of 10.0.0.1, dotted"],
  ["100::1", "discard-only"],
  ["2001::1", "Teredo"],
  ["2001:db8::1", "documentation"],
  ["2002:a00:1::", "6to4 of 10.0.0.1"],
  ["3fff::1", "documentation"],
  ["::ffff:10.0.0.1", "IPv4-mapped private, dotted"],
  ["::ffff:a00:1", "IPv4-mapped private, hex"],
  ["0:0:0:0:0:ffff:10.0.0.1", "IPv4-mapped private, expanded"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback, dotted"],
  ["::ffff:7f00:1", "IPv4-mapped loopback, hex"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ["::ffff:a9fe:a9fe", "IPv4-mapped metadata, hex"],
  ["::ffff:0.0.0.0", "IPv4-mapped unspecified"],
  ["::ffff:192.168.0.1", "IPv4-mapped RFC1918"],
  ["::ffff:100.64.0.1", "IPv4-mapped CGNAT"],
];

const PUBLIC_V6: ReadonlyArray<string> = [
  "2606:4700:4700::1111",
  "2a00:1450:4001:81b::200e",
  "2001:4860:4860::8888",
  "2400:cb00::1",
  "::ffff:8.8.8.8", // a mapped PUBLIC address is judged by the address inside it
];

const NOT_AN_ADDRESS: ReadonlyArray<unknown> = [
  "",
  " ",
  "not-an-ip",
  "example.com",
  "1.2.3",
  "1.2.3.4.5",
  "256.1.1.1",
  "1.2.3.4/8",
  " 8.8.8.8",
  "8.8.8.8 ",
  "0x7f.0.0.1",
  "127.1",
  "2130706433",
  "08.8.8.8",
  "::g",
  "1::2::3",
  "fe80::1%eth0",
  "[::1]",
  "::ffff:1.2.3",
  "::ffff:10.0.0.1.5",
  undefined,
  null,
  8,
  {},
];

describe("isPublicAddress: IPv4", () => {
  it.each(BLOCKED_V4)("%s is refused (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(PUBLIC_V4)("%s is public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("isPublicAddress: IPv6", () => {
  it.each(BLOCKED_V6)("%s is refused (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(PUBLIC_V6)("%s is public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("isPublicAddress: anything that is not a plain address fails closed", () => {
  it.each(
    NOT_AN_ADDRESS.map((value) => [JSON.stringify(value) ?? String(value), value]),
  )("%s is refused", (_label, value) => {
    expect(isPublicAddress(value as string)).toBe(false);
  });
});
