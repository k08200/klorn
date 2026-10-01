/**
 * C3: the CalDAV HTTP layer and its SSRF guard. Every hop (the first request and
 * every redirect) is checked by the provider's host guard, its name is resolved
 * and every answer must be public, and the request goes to that checked address.
 * Redirects are followed by hand, a bounded number of times, each re-validated.
 * Responses are size-capped and every request runs under a timeout and the
 * sync's overall deadline.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CaldavGuardError,
  CaldavHttpError,
  CaldavLimitError,
  type CaldavProtocolError,
} from "../pim/caldav/caldav-errors.js";
import {
  CALDAV_MAX_REDIRECTS,
  CALDAV_MAX_RESPONSE_BYTES,
  type CaldavConnection,
  type CaldavTransport,
  caldavRequest,
  type TransportRequest,
} from "../pim/caldav/caldav-http.js";
import { CALDAV_PROVIDERS } from "../pim/caldav/caldav-providers.js";
import { pinnedLookup, readCappedBody } from "../pim/caldav/caldav-transport.js";
import { isRevokedGrantError } from "../pim/linked-calendar-failure.js";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/gmail.js", () => ({ markLinkedCalendarForReconnect: vi.fn(async () => {}) }));

const PUBLIC_V4 = "17.248.1.10";
const PARTITION_V4 = "17.248.2.20";

function publicResolver(map: Record<string, readonly string[]> = {}) {
  return vi.fn(async (host: string) => map[host] ?? [PUBLIC_V4]);
}

function connection(
  transport: CaldavTransport,
  overrides: Partial<CaldavConnection> = {},
): CaldavConnection {
  return {
    provider: CALDAV_PROVIDERS.ICLOUD,
    username: "me@icloud.com",
    password: "abcd-efgh-ijkl-mnop",
    deadline: Date.now() + 60_000,
    requestTimeoutMs: 5_000,
    transport,
    resolve: publicResolver(),
    now: () => Date.now(),
    ...overrides,
  };
}

const PROPFIND = {
  method: "PROPFIND" as const,
  url: "https://caldav.icloud.com/",
  depth: "0" as const,
  body: "<propfind/>",
};

function ok(body = "<multistatus/>") {
  return { status: 207, location: null, body };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("caldavRequest: the request itself", () => {
  it("sends Basic auth, Depth, the method and body to the address the guard pinned", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ok("<multistatus>x</multistatus>"));
    const response = await caldavRequest(connection(transport), PROPFIND);

    expect(response.status).toBe(207);
    expect(response.body).toBe("<multistatus>x</multistatus>");
    const sent = transport.mock.calls[0][0] as TransportRequest;
    expect(sent.url.href).toBe("https://caldav.icloud.com/");
    expect(sent.address).toEqual({ address: PUBLIC_V4, family: 4 });
    expect(sent.method).toBe("PROPFIND");
    expect(sent.body).toBe("<propfind/>");
    expect(sent.headers.Depth).toBe("0");
    expect(sent.headers.Authorization).toBe(
      `Basic ${Buffer.from("me@icloud.com:abcd-efgh-ijkl-mnop").toString("base64")}`,
    );
    expect(sent.headers["Accept-Encoding"]).toBe("identity");
    expect(sent.maxBytes).toBe(CALDAV_MAX_RESPONSE_BYTES);
  });

  it("refuses a URL outside the provider's hosts before resolving or connecting", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ok());
    const resolve = publicResolver();
    const err = await errorOf(
      caldavRequest(connection(transport, { resolve }), {
        ...PROPFIND,
        url: "https://169.254.169.254/latest/meta-data/",
      }),
    );
    expect(err).toBeInstanceOf(CaldavGuardError);
    expect((err as CaldavGuardError).code).toBe("ip-literal");
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("caldavRequest: DNS is resolved and checked public before connecting", () => {
  it.each([
    ["10.0.0.5"],
    ["127.0.0.1"],
    ["169.254.169.254"],
    ["100.100.100.200"],
    ["::1"],
    ["fd00:ec2::254"],
    ["::ffff:10.0.0.1"],
  ])("an allowlisted name that resolves to %s is refused", async (address) => {
    const transport = vi.fn<CaldavTransport>(async () => ok());
    const err = await errorOf(
      caldavRequest(
        connection(transport, { resolve: publicResolver({ "caldav.icloud.com": [address] }) }),
        PROPFIND,
      ),
    );
    expect((err as CaldavGuardError).code).toBe("blocked-address");
    expect(transport).not.toHaveBeenCalled();
  });

  it("one private answer among public ones is enough to refuse", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ok());
    const resolve = publicResolver({ "caldav.icloud.com": [PUBLIC_V4, "10.1.2.3"] });
    const err = await errorOf(caldavRequest(connection(transport, { resolve }), PROPFIND));
    expect((err as CaldavGuardError).code).toBe("blocked-address");
    expect(transport).not.toHaveBeenCalled();
  });

  it("a name with no answer, or a failing resolver, is refused", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ok());
    const empty = vi.fn(async () => [] as string[]);
    expect(
      (
        (await errorOf(caldavRequest(connection(transport, { resolve: empty }), PROPFIND))) as {
          code: string;
        }
      ).code,
    ).toBe("unresolvable");
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    });
    expect(
      (
        (await errorOf(caldavRequest(connection(transport, { resolve: failing }), PROPFIND))) as {
          code: string;
        }
      ).code,
    ).toBe("unresolvable");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("caldavRequest: redirects are followed by hand, each hop re-validated", () => {
  it("follows a redirect to a partition host, re-resolving it and re-sending the method and body", async () => {
    const transport = vi
      .fn<CaldavTransport>()
      .mockResolvedValueOnce({
        status: 301,
        location: "https://p42-caldav.icloud.com/123/principal/",
        body: "",
      })
      .mockResolvedValueOnce(ok("<multistatus>moved</multistatus>"));
    const resolve = publicResolver({ "p42-caldav.icloud.com": [PARTITION_V4] });
    const response = await caldavRequest(connection(transport, { resolve }), PROPFIND);

    expect(response.body).toBe("<multistatus>moved</multistatus>");
    expect(response.url.href).toBe("https://p42-caldav.icloud.com/123/principal/");
    const second = transport.mock.calls[1][0] as TransportRequest;
    expect(second.address.address).toBe(PARTITION_V4);
    expect(second.method).toBe("PROPFIND");
    expect(second.body).toBe("<propfind/>");
    expect(resolve).toHaveBeenCalledWith("p42-caldav.icloud.com");
  });

  it("resolves a relative Location against the URL that answered", async () => {
    const transport = vi
      .fn<CaldavTransport>()
      .mockResolvedValueOnce({ status: 308, location: "/other/", body: "" })
      .mockResolvedValueOnce(ok());
    const response = await caldavRequest(connection(transport), PROPFIND);
    expect(response.url.href).toBe("https://caldav.icloud.com/other/");
  });

  it.each([
    ["https://evil.example/steal", "host"],
    ["https://10.0.0.1/", "ip-literal"],
    ["http://p42-caldav.icloud.com/", "scheme"],
    ["https://me:pw@p42-caldav.icloud.com/", "userinfo"],
    ["https://p42-caldav.icloud.com:8443/", "port"],
    ["https://caldav.calendar.naver.com/", "host"],
  ])("a redirect to %s is refused (%s) and the credentials never leave", async (location, code) => {
    const transport = vi
      .fn<CaldavTransport>()
      .mockResolvedValueOnce({ status: 302, location, body: "" })
      .mockResolvedValue(ok());
    const err = await errorOf(caldavRequest(connection(transport), PROPFIND));
    expect((err as CaldavGuardError).code).toBe(code);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("a redirect whose host resolves privately is refused at that hop", async () => {
    const transport = vi
      .fn<CaldavTransport>()
      .mockResolvedValueOnce({ status: 307, location: "https://p7-caldav.icloud.com/", body: "" })
      .mockResolvedValue(ok());
    const resolve = publicResolver({ "p7-caldav.icloud.com": ["192.168.1.1"] });
    const err = await errorOf(caldavRequest(connection(transport, { resolve }), PROPFIND));
    expect((err as CaldavGuardError).code).toBe("blocked-address");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${CALDAV_MAX_REDIRECTS} redirects`, async () => {
    const transport = vi.fn<CaldavTransport>(async () => ({
      status: 302,
      location: "https://caldav.icloud.com/loop/",
      body: "",
    }));
    const err = await errorOf(caldavRequest(connection(transport), PROPFIND));
    expect((err as CaldavGuardError).code).toBe("redirect-limit");
    expect(transport).toHaveBeenCalledTimes(CALDAV_MAX_REDIRECTS + 1);
  });

  it("a redirect without a Location is refused", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ({
      status: 301,
      location: null,
      body: "",
    }));
    const err = await errorOf(caldavRequest(connection(transport), PROPFIND));
    expect((err as CaldavGuardError).code).toBe("redirect-without-location");
  });
});

describe("caldavRequest: status handling", () => {
  it("401 is a CaldavHttpError the failure policy reads as a revoked credential", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ({
      status: 401,
      location: null,
      body: "<error>Unauthorized for me@icloud.com</error>",
    }));
    const err = await errorOf(caldavRequest(connection(transport), PROPFIND));
    expect(err).toBeInstanceOf(CaldavHttpError);
    expect(isRevokedGrantError(err)).toBe(true);
    expect((err as Error).message).not.toContain("me@icloud.com");
  });

  it("a 5xx is an error that is not a revoked credential, and carries no server text", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ({
      status: 503,
      location: null,
      body: "internal host db-7.apple.internal down",
    }));
    const err = await errorOf(caldavRequest(connection(transport), PROPFIND));
    expect((err as CaldavHttpError).status).toBe(503);
    expect(isRevokedGrantError(err)).toBe(false);
    expect((err as Error).message).not.toContain("db-7");
  });
});

describe("caldavRequest: time bounds", () => {
  it("a response slower than the request timeout is abandoned and its request aborted", async () => {
    let aborted = false;
    const transport = vi.fn<CaldavTransport>(
      (req) =>
        new Promise(() => {
          req.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const err = await errorOf(
      caldavRequest(connection(transport, { requestTimeoutMs: 30 }), PROPFIND),
    );
    expect(err).toBeInstanceOf(CaldavLimitError);
    expect((err as CaldavLimitError).kind).toBe("timeout");
    expect(aborted).toBe(true);
  });

  it("a transport that ignores the abort signal still cannot hold the caller", async () => {
    const transport = vi.fn<CaldavTransport>(() => new Promise(() => {}));
    const started = Date.now();
    await errorOf(caldavRequest(connection(transport, { requestTimeoutMs: 30 }), PROPFIND));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the sync deadline caps a request even when the per-request timeout is longer", async () => {
    const transport = vi.fn<CaldavTransport>(() => new Promise(() => {}));
    const err = await errorOf(
      caldavRequest(
        connection(transport, { requestTimeoutMs: 60_000, deadline: Date.now() + 30 }),
        PROPFIND,
      ),
    );
    expect((err as CaldavLimitError).kind).toBe("deadline");
  });

  it("nothing is sent once the deadline has passed", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ok());
    const err = await errorOf(
      caldavRequest(connection(transport, { deadline: Date.now() - 1 }), PROPFIND),
    );
    expect((err as CaldavLimitError).kind).toBe("deadline");
    expect(transport).not.toHaveBeenCalled();
  });

  it("a resolver that stalls is bounded by the same deadline", async () => {
    const transport = vi.fn<CaldavTransport>(async () => ok());
    const resolve = vi.fn(() => new Promise<string[]>(() => {}));
    const err = await errorOf(
      caldavRequest(connection(transport, { resolve, deadline: Date.now() + 30 }), PROPFIND),
    );
    expect((err as CaldavLimitError).kind).toBe("deadline");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("the default transport's pieces", () => {
  it("pinnedLookup answers the pinned address whatever name is asked, in both callback shapes", () => {
    const lookup = pinnedLookup({ address: PUBLIC_V4, family: 4 });
    const single = vi.fn();
    lookup("caldav.icloud.com", {}, single);
    expect(single).toHaveBeenCalledWith(null, PUBLIC_V4, 4);
    const all = vi.fn();
    lookup("caldav.icloud.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_V4, family: 4 }]);
  });

  it("readCappedBody returns the body under the cap", async () => {
    const stream = new PassThrough();
    const pending = readCappedBody(stream, { "content-length": "5" }, 10);
    stream.end("hello");
    await expect(pending).resolves.toBe("hello");
  });

  it("readCappedBody stops reading an oversized response and destroys the stream", async () => {
    const stream = new PassThrough();
    const pending = readCappedBody(stream, {}, 10);
    stream.write("0123456789");
    stream.write("x");
    const err = await errorOf(pending);
    expect((err as CaldavLimitError).kind).toBe("too-large");
    expect(stream.destroyed).toBe(true);
  });

  it("readCappedBody refuses a declared Content-Length over the cap before reading", async () => {
    const stream = new PassThrough();
    const err = await errorOf(readCappedBody(stream, { "content-length": "11" }, 10));
    expect((err as CaldavLimitError).kind).toBe("too-large");
    expect(stream.destroyed).toBe(true);
  });

  it("readCappedBody refuses a compressed body (identity was asked for)", async () => {
    const stream = new PassThrough();
    const err = await errorOf(readCappedBody(stream, { "content-encoding": "gzip" }, 10));
    expect((err as CaldavProtocolError).code).toBe("encoding");
  });
});
