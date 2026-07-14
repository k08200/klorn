import { describe, expect, it } from "vitest";
import { isSafePushEndpoint } from "../is-safe-push-endpoint.js";

describe("isSafePushEndpoint", () => {
  it("accepts a normal public HTTPS endpoint", () => {
    expect(isSafePushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isSafePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/xyz")).toBe(true);
  });

  it("rejects non-HTTPS protocols", () => {
    expect(isSafePushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isSafePushEndpoint("ftp://example.com/foo")).toBe(false);
  });

  it("rejects loopback and link-local hostnames", () => {
    expect(isSafePushEndpoint("https://localhost/x")).toBe(false);
    expect(isSafePushEndpoint("https://LOCALHOST/x")).toBe(false);
    expect(isSafePushEndpoint("https://127.0.0.1/x")).toBe(false);
    expect(isSafePushEndpoint("https://[::1]/x")).toBe(false);
  });

  it("rejects internal and .local domains", () => {
    expect(isSafePushEndpoint("https://service.internal/x")).toBe(false);
    expect(isSafePushEndpoint("https://printer.local/x")).toBe(false);
  });

  it("rejects RFC1918 and link-local IPv4 ranges", () => {
    expect(isSafePushEndpoint("https://10.0.0.1/x")).toBe(false);
    expect(isSafePushEndpoint("https://10.255.255.255/x")).toBe(false);
    expect(isSafePushEndpoint("https://172.16.0.1/x")).toBe(false);
    expect(isSafePushEndpoint("https://172.31.255.1/x")).toBe(false);
    expect(isSafePushEndpoint("https://192.168.1.1/x")).toBe(false);
    expect(isSafePushEndpoint("https://169.254.169.254/x")).toBe(false);
    expect(isSafePushEndpoint("https://0.0.0.0/x")).toBe(false);
  });

  it("accepts public IPv4 addresses", () => {
    expect(isSafePushEndpoint("https://8.8.8.8/x")).toBe(true);
    expect(isSafePushEndpoint("https://1.1.1.1/x")).toBe(true);
    expect(isSafePushEndpoint("https://172.15.0.1/x")).toBe(true); // just outside 172.16/12
    expect(isSafePushEndpoint("https://172.32.0.1/x")).toBe(true); // just outside 172.16/12
  });

  it("rejects malformed URLs", () => {
    expect(isSafePushEndpoint("not a url")).toBe(false);
    expect(isSafePushEndpoint("")).toBe(false);
  });

  it("rejects the whole IPv4 loopback /8, not just the 127.0.0.1 literal", () => {
    expect(isSafePushEndpoint("https://127.0.0.2/x")).toBe(false);
    expect(isSafePushEndpoint("https://127.255.255.255/x")).toBe(false);
  });

  it("rejects IPv6 loopback and unspecified in every textual form", () => {
    expect(isSafePushEndpoint("https://[0:0:0:0:0:0:0:1]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[::]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[0:0:0:0:0:0:0:0]/x")).toBe(false);
  });

  it("rejects IPv6 unique-local addresses (fc00::/7)", () => {
    expect(isSafePushEndpoint("https://[fc00::1]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[fd12:3456:789a::1]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[fdff::1]/x")).toBe(false);
  });

  it("rejects IPv6 link-local addresses (fe80::/10)", () => {
    expect(isSafePushEndpoint("https://[fe80::1]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[febf::ffff]/x")).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 wrapping a private or loopback IPv4", () => {
    expect(isSafePushEndpoint("https://[::ffff:10.0.0.1]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[::ffff:192.168.1.1]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[::ffff:127.0.0.1]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[::ffff:169.254.169.254]/x")).toBe(false);
    expect(isSafePushEndpoint("https://[0:0:0:0:0:ffff:10.0.0.1]/x")).toBe(false);
  });

  it("accepts public IPv6 addresses and boundary neighbors of private ranges", () => {
    expect(isSafePushEndpoint("https://[2606:4700::1111]/x")).toBe(true);
    expect(isSafePushEndpoint("https://[2600:1901::1]/x")).toBe(true);
    // fbff is just below fc00::/7; fec0 is just past fe80::/10.
    expect(isSafePushEndpoint("https://[fbff::1]/x")).toBe(true);
    expect(isSafePushEndpoint("https://[fec0::1]/x")).toBe(true);
    // IPv4-mapped wrapping a public IPv4 stays allowed.
    expect(isSafePushEndpoint("https://[::ffff:8.8.8.8]/x")).toBe(true);
  });
});
