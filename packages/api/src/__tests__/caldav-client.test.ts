import { describe, expect, it, vi } from "vitest";
import {
  assertResolvesPublicly,
  assertSafeCalDavUrl,
  CalDavError,
  discoverCalendarHome,
  type FetchLike,
  fetchEventDocuments,
  isPrivateAddress,
  listCalendars,
  resolveHref,
  toCalDavStamp,
} from "../pim/caldav/client.js";
import {
  calDavProviderById,
  domainFromAddress,
  wellKnownCalDavUrl,
} from "../pim/caldav/providers.js";
import { decodeEntities, findElements, findText, hasElement } from "../pim/caldav/xml.js";

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34" }];

const CREDS = {
  baseUrl: "https://caldav.example.com",
  username: "ada@example.com",
  password: "app-specific",
};

/** Build a Response-like object good enough for the client's use of it. */
function xmlResponse(status: number, body: string): Response {
  return { status, text: async () => body } as unknown as Response;
}

describe("CalDAV xml helpers", () => {
  it("matches elements regardless of namespace prefix", () => {
    // The same document is d:href from iCloud, D:href from another server and
    // href from a third. Matching a literal prefix is the bug that makes a
    // client work against one provider and fail against the next.
    for (const doc of [
      "<d:multistatus><d:href>/a/</d:href></d:multistatus>",
      "<D:multistatus><D:href>/a/</D:href></D:multistatus>",
      "<multistatus><href>/a/</href></multistatus>",
    ]) {
      expect(findText(doc, "href")).toBe("/a/");
    }
  });

  it("does not truncate a block when the same element nests", () => {
    const doc = "<response><x><response><href>/inner/</href></response></x><k>1</k></response>";
    const [outer] = findElements(doc, "response");
    expect(outer).toContain("<k>1</k>");
  });

  it("sees a self-closing element", () => {
    expect(hasElement("<resourcetype><collection/><c:calendar/></resourcetype>", "calendar")).toBe(
      true,
    );
    expect(hasElement("<resourcetype><collection/></resourcetype>", "calendar")).toBe(false);
  });

  it("decodes entities without double-decoding an escaped one", () => {
    expect(decodeEntities("a &amp;lt; b")).toBe("a &lt; b");
    expect(decodeEntities("&lt;VEVENT&gt;")).toBe("<VEVENT>");
  });
});

describe("assertSafeCalDavUrl", () => {
  it("requires https, because credentials ride every request", () => {
    expect(() => assertSafeCalDavUrl("http://caldav.example.com")).toThrow(CalDavError);
  });

  it("refuses private and link-local addresses", () => {
    // A user-supplied host is an SSRF surface: 169.254.169.254 is a cloud
    // metadata endpoint, not a calendar.
    for (const host of [
      "https://localhost/dav",
      "https://127.0.0.1/dav",
      "https://10.0.0.5/dav",
      "https://192.168.1.10/dav",
      "https://169.254.169.254/dav",
      "https://172.16.0.1/dav",
    ]) {
      expect(() => assertSafeCalDavUrl(host)).toThrow(CalDavError);
    }
  });

  it("allows an ordinary public host", () => {
    expect(assertSafeCalDavUrl("https://caldav.icloud.com").hostname).toBe("caldav.icloud.com");
  });
});

describe("assertResolvesPublicly", () => {
  it("rejects a public-looking name that resolves to loopback", async () => {
    // The whole point: internal.attacker.com is a legal public hostname and
    // the syntactic check passes it. Only resolution catches this.
    const lookup = async () => [{ address: "127.0.0.1" }];
    await expect(assertResolvesPublicly("internal.attacker.com", lookup)).rejects.toThrow(
      /private address/i,
    );
  });

  it("rejects when any answer in the record set is private", async () => {
    // A mixed record set would otherwise pass and then connect to whichever
    // address the stack happened to pick.
    const lookup = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.7" }];
    await expect(assertResolvesPublicly("mixed.example.com", lookup)).rejects.toThrow(
      /private address/i,
    );
  });

  it("accepts a name that resolves only to public addresses", async () => {
    const lookup = async () => [{ address: "17.253.144.10" }];
    await expect(assertResolvesPublicly("caldav.icloud.com", lookup)).resolves.toBeUndefined();
  });

  it("treats an unresolvable name as a refusal, not a pass", async () => {
    const lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertResolvesPublicly("nope.invalid", lookup)).rejects.toThrow(/resolve/i);
    await expect(assertResolvesPublicly("empty.invalid", async () => [])).rejects.toThrow(
      /resolve/i,
    );
  });

  it("checks a literal address directly instead of resolving it", async () => {
    const lookup = async () => {
      throw new Error("should not be called for a literal");
    };
    await expect(assertResolvesPublicly("169.254.169.254", lookup)).rejects.toThrow(
      /private address/i,
    );
    await expect(assertResolvesPublicly("93.184.216.34", lookup)).resolves.toBeUndefined();
  });

  it("sees through an IPv4-mapped IPv6 address", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:93.184.216.34")).toBe(false);
  });

  it("blocks carrier-grade NAT, which is private despite looking routable", () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("100.128.0.1")).toBe(false);
  });
});

describe("resolveHref", () => {
  it("resolves a path against the server base", () => {
    expect(resolveHref("/1234/calendars/", "https://caldav.icloud.com/x")).toBe(
      "https://caldav.icloud.com/1234/calendars/",
    );
  });

  it("keeps an absolute href", () => {
    expect(resolveHref("https://other.example.com/c/", "https://caldav.example.com/")).toBe(
      "https://other.example.com/c/",
    );
  });
});

describe("discoverCalendarHome", () => {
  it("walks root → principal → calendar-home-set", () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return xmlResponse(
          207,
          `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>
             <d:current-user-principal><d:href>/principals/1234/</d:href></d:current-user-principal>
           </d:prop></d:propstat></d:response></d:multistatus>`,
        );
      }
      return xmlResponse(
        207,
        `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop>
           <c:calendar-home-set><d:href>/1234/calendars/</d:href></c:calendar-home-set>
         </d:prop></d:propstat></d:response></d:multistatus>`,
      );
    });

    return discoverCalendarHome(CREDS, fetchImpl, PUBLIC_LOOKUP).then((home) => {
      expect(home).toBe("https://caldav.example.com/1234/calendars/");
      expect(calls[1]).toBe("https://caldav.example.com/principals/1234/");
    });
  });

  it("explains that an app-specific password is needed when the server says 401", async () => {
    const fetchImpl: FetchLike = async () => xmlResponse(401, "");
    await expect(discoverCalendarHome(CREDS, fetchImpl, PUBLIC_LOOKUP)).rejects.toThrow(
      /app-specific password/i,
    );
  });

  it("fails loudly when the server returns no principal", async () => {
    const fetchImpl: FetchLike = async () =>
      xmlResponse(207, '<d:multistatus xmlns:d="DAV:"></d:multistatus>');
    await expect(discoverCalendarHome(CREDS, fetchImpl, PUBLIC_LOOKUP)).rejects.toThrow(
      /current-user-principal/,
    );
  });
});

describe("listCalendars", () => {
  const HOME = "https://caldav.example.com/1234/calendars/";
  const MULTISTATUS = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:response>
      <d:href>/1234/calendars/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>
      <d:displayname>Home</d:displayname></d:prop></d:propstat>
    </d:response>
    <d:response>
      <d:href>/1234/calendars/work/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Work</d:displayname></d:prop></d:propstat>
    </d:response>
    <d:response>
      <d:href>/1234/calendars/inbox/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>
      <d:displayname>Inbox</d:displayname></d:prop></d:propstat>
    </d:response>
  </d:multistatus>`;

  it("returns only collections that are actually calendars", async () => {
    // The home also holds a scheduling inbox and plain collections. Filtering
    // on resourcetype — not on the URL shape — is what keeps them out.
    const fetchImpl: FetchLike = async () => xmlResponse(207, MULTISTATUS);
    const calendars = await listCalendars(CREDS, HOME, fetchImpl);
    expect(calendars).toEqual([
      { url: "https://caldav.example.com/1234/calendars/work/", displayName: "Work" },
    ]);
  });

  it("sends Depth: 1, since the calendars are children of the home", async () => {
    const fetchImpl = vi.fn(async () => xmlResponse(207, MULTISTATUS)) as unknown as FetchLike;
    await listCalendars(CREDS, HOME, fetchImpl);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Depth).toBe("1");
  });
});

describe("fetchEventDocuments", () => {
  const CAL = "https://caldav.example.com/1234/calendars/work/";

  it("asks the server to do the windowing and returns raw ICS", async () => {
    let sentBody = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      sentBody = String(init.body);
      return xmlResponse(
        207,
        `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
           <d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
END:VEVENT
END:VCALENDAR</c:calendar-data></d:prop></d:propstat>
         </d:response></d:multistatus>`,
      );
    };

    const docs = await fetchEventDocuments(
      CREDS,
      CAL,
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
      fetchImpl,
    );
    // Server-side time-range, not fetch-everything-and-filter: that is the
    // difference between usable and unusable on a ten-year calendar.
    expect(sentBody).toContain("time-range");
    expect(sentBody).toContain('start="20260901T000000Z"');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toContain("UID:a");
  });

  it("decodes entity-escaped calendar data", async () => {
    const fetchImpl: FetchLike = async () =>
      xmlResponse(
        207,
        `<multistatus><response><calendar-data>SUMMARY:Tea &amp; biscuits</calendar-data></response></multistatus>`,
      );
    const [doc] = await fetchEventDocuments(CREDS, CAL, new Date(0), new Date(1), fetchImpl);
    expect(doc).toContain("Tea & biscuits");
  });
});

describe("toCalDavStamp", () => {
  it("formats an instant the way the filter expects", () => {
    expect(toCalDavStamp(new Date("2026-09-29T14:00:00.000Z"))).toBe("20260929T140000Z");
  });
});

describe("providers", () => {
  it("knows iCloud and says an app-specific password is required", () => {
    const icloud = calDavProviderById("icloud");
    expect(icloud?.baseUrl).toBe("https://caldav.icloud.com");
    // Without this hint the user sees "wrong password" and gives up.
    expect(icloud?.credentialHint).toMatch(/app-specific/i);
  });

  it("builds a well-known URL for an arbitrary domain", () => {
    // This is the path that reaches Nextcloud, company and self-hosted servers
    // without any entry in the preset table.
    expect(wellKnownCalDavUrl("example.com")).toBe("https://example.com/.well-known/caldav");
    expect(domainFromAddress("ada@example.com")).toBe("example.com");
  });

  it("refuses a domain that is not usable", () => {
    expect(() => wellKnownCalDavUrl("not a domain")).toThrow();
    expect(() => domainFromAddress("no-at-sign")).toThrow();
  });
});
