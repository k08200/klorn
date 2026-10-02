/**
 * C4: Calendars.Read is requested ONLY for a calendar link. The inbox link's
 * scope set is unchanged, so every existing consent stays exactly as granted and
 * no inbox link ever asks the user (or an org admin) for calendar access.
 * Microsoft's docs: https://learn.microsoft.com/graph/api/calendar-list-calendarview
 * lists Calendars.Read for delegated work/school and personal accounts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_REDIRECT_URI", "MS_TENANT"] as const;
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn();

// The inbox scope set exactly as it was before C4 (mail/outlook-oauth.ts).
const INBOX_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
];
const CALENDAR_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Calendars.Read",
];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MS_CLIENT_ID = "client-123";
  process.env.MS_CLIENT_SECRET = "secret-456";
  process.env.MS_REDIRECT_URI = "https://api.example.com/api/auth/outlook/callback";
  delete process.env.MS_TENANT;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), {
      status: 200,
    }),
  );
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const mod = await import("../mail/outlook-oauth.js");

function scopesOf(url: string): string[] {
  return (new URL(url).searchParams.get("scope") ?? "").split(" ");
}
function tokenBodyScopes(): string[] {
  const init = fetchMock.mock.calls[0]?.[1] as { body: URLSearchParams };
  return (init.body.get("scope") ?? "").split(" ");
}

describe("the authorize URL", () => {
  it("keeps the inbox scope set exactly as it was, with no calendar scope (default)", () => {
    expect(scopesOf(mod.getOutlookAuthUrl("s"))).toEqual(INBOX_SCOPES);
    expect(scopesOf(mod.getOutlookAuthUrl("s", "inbox"))).toEqual(INBOX_SCOPES);
    expect(mod.getOutlookAuthUrl("s")).not.toContain("Calendars");
  });

  it("asks for Calendars.Read on a calendar link, and for no mail access", () => {
    const scopes = scopesOf(mod.getOutlookAuthUrl("s", "calendar"));

    expect(scopes).toEqual(CALENDAR_SCOPES);
    expect(scopes.some((s) => s.includes("Mail."))).toBe(false);
    // Read-only: never the write scope.
    expect(scopes.some((s) => s.includes("Calendars.ReadWrite"))).toBe(false);
  });

  it("uses the same authority, client and redirect URI for both, so Azure needs no new redirect", () => {
    const inbox = new URL(mod.getOutlookAuthUrl("s", "inbox"));
    const calendar = new URL(mod.getOutlookAuthUrl("s", "calendar"));

    expect(calendar.origin + calendar.pathname).toBe(inbox.origin + inbox.pathname);
    expect(calendar.searchParams.get("redirect_uri")).toBe(inbox.searchParams.get("redirect_uri"));
    expect(calendar.searchParams.get("client_id")).toBe(inbox.searchParams.get("client_id"));
    expect(calendar.searchParams.get("state")).toBe("s");
  });
});

describe("the code exchange", () => {
  it("requests the inbox scopes by default, never a calendar scope", async () => {
    await mod.exchangeOutlookCode("code-1");
    expect(tokenBodyScopes()).toEqual(INBOX_SCOPES);
  });

  it("requests the calendar scopes for a calendar link", async () => {
    await mod.exchangeOutlookCode("code-1", "calendar");
    expect(tokenBodyScopes()).toEqual(CALENDAR_SCOPES);
  });
});

describe("the refresh grant", () => {
  it("requests the inbox scopes by default: an existing inbox link's token is unchanged", async () => {
    await mod.refreshOutlookTokens("rt-1");
    expect(tokenBodyScopes()).toEqual(INBOX_SCOPES);
  });

  it("requests the calendar scopes for a calendar account, so the new access token can read calendars", async () => {
    await mod.refreshOutlookTokens("rt-1", "calendar");
    expect(tokenBodyScopes()).toEqual(CALENDAR_SCOPES);
  });
});
