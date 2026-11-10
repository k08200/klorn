/**
 * D5b characterisation: the four Google consent URLs that existed before the
 * Drive connector (sign-in, the Gmail/Calendar connect, the calendar link and
 * the inbox link), pinned EXACTLY as main builds them, with the real
 * googleapis client. D5 must never change the scopes or the parameters any of
 * them requests (docs/providers/unified-platform-plan.md, D5: "D5 never changes
 * the production consent screen or the scopes that sign-in, Gmail, Calendar and
 * the inbox links request"). An added parameter (`include_granted_scopes`
 * above all) or scope fails here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const CLIENT_ID = "pinned-client.apps.googleusercontent.com";
const REDIRECT_URI = "https://api.example.test/api/auth/google/callback";
const ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const STATE = "signed-state-abc";

async function loadGmail() {
  vi.resetModules();
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "pinned-secret");
  vi.stubEnv("GOOGLE_REDIRECT_URI", REDIRECT_URI);
  return import("../mail/gmail.js");
}

/** The endpoint and every query parameter, so an added or dropped one fails. */
function parts(url: string): { endpoint: string; params: Record<string, string> } {
  const parsed = new URL(url);
  return {
    endpoint: `${parsed.origin}${parsed.pathname}`,
    params: Object.fromEntries(parsed.searchParams),
  };
}

const COMMON = {
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  state: STATE,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the consent URLs main builds (pinned before D5b)", () => {
  it("sign-in: identity only, account chooser, no offline access", async () => {
    const { getLoginAuthUrl } = await loadGmail();
    expect(parts(getLoginAuthUrl(STATE))).toEqual({
      endpoint: ENDPOINT,
      params: {
        ...COMMON,
        prompt: "select_account",
        scope:
          "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
      },
    });
  });

  it("the Gmail and Calendar connect: the five verified scopes, offline, consent", async () => {
    const { getAuthUrl } = await loadGmail();
    expect(parts(getAuthUrl(STATE))).toEqual({
      endpoint: ENDPOINT,
      params: {
        ...COMMON,
        access_type: "offline",
        prompt: "consent",
        scope: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/calendar.readonly",
        ].join(" "),
      },
    });
  });

  it("the calendar link: identity and calendar.readonly, offline, consent", async () => {
    const { getLinkCalendarAuthUrl } = await loadGmail();
    expect(parts(getLinkCalendarAuthUrl(STATE))).toEqual({
      endpoint: ENDPOINT,
      params: {
        ...COMMON,
        access_type: "offline",
        prompt: "consent",
        scope:
          "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly",
      },
    });
  });

  it("the inbox link: identity and the three Gmail scopes, offline, consent", async () => {
    const { getLinkInboxAuthUrl } = await loadGmail();
    expect(parts(getLinkInboxAuthUrl(STATE))).toEqual({
      endpoint: ENDPOINT,
      params: {
        ...COMMON,
        access_type: "offline",
        prompt: "consent",
        scope: [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.modify",
        ].join(" "),
      },
    });
  });

  it("no existing URL asks for drive or for include_granted_scopes", async () => {
    const gmail = await loadGmail();
    const urls = [
      gmail.getLoginAuthUrl(STATE),
      gmail.getAuthUrl(STATE),
      gmail.getLinkCalendarAuthUrl(STATE),
      gmail.getLinkInboxAuthUrl(STATE),
    ];
    for (const url of urls) {
      expect(url).not.toContain("drive");
      expect(url).not.toContain("include_granted_scopes");
    }
  });
});
