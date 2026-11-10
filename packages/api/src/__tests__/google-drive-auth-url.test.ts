/**
 * D5b: the consent URL of a Google Drive link (drive/providers/google-auth.ts),
 * built by the real googleapis client and pinned exactly. It asks for the
 * identity scopes and `drive.file` only, offline and with consent, under the
 * existing client id and redirect URI (so the console needs no change), and
 * never with `include_granted_scopes`: with it, picking the primary's Google
 * account would hand back a token that also carries Gmail and Calendar (plan,
 * D5 "Grant"). The state is server-signed, names the user and the
 * `__link_drive__` marker, and lives 10 minutes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const CLIENT_ID = "pinned-client.apps.googleusercontent.com";
const REDIRECT_URI = "https://api.example.test/api/auth/google/callback";

async function load() {
  vi.resetModules();
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "pinned-secret");
  vi.stubEnv("GOOGLE_REDIRECT_URI", REDIRECT_URI);
  const auth = await import("../drive/providers/google-auth.js");
  const gmail = await import("../mail/gmail.js");
  const { verifyToken } = await import("../auth.js");
  return { ...auth, gmail, verifyToken };
}

function parts(url: string): { endpoint: string; params: Record<string, string> } {
  const parsed = new URL(url);
  return {
    endpoint: `${parsed.origin}${parsed.pathname}`,
    params: Object.fromEntries(parsed.searchParams),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getLinkDriveAuthUrl", () => {
  it("asks for exactly openid, userinfo.email and drive.file, offline, with consent", async () => {
    const { getLinkDriveAuthUrl } = await load();
    const { endpoint, params } = parts(getLinkDriveAuthUrl("user-1"));
    expect(endpoint).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.keys(params).sort()).toEqual([
      "access_type",
      "client_id",
      "prompt",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
    expect(params).toMatchObject({
      access_type: "offline",
      prompt: "consent",
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    expect(params.scope?.split(" ")).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/drive.file",
    ]);
  });

  it("never asks for include_granted_scopes", async () => {
    const { getLinkDriveAuthUrl } = await load();
    expect(getLinkDriveAuthUrl("user-1")).not.toContain("include_granted_scopes");
  });

  it("uses the client id and redirect URI of the existing flows", async () => {
    const { getLinkDriveAuthUrl, gmail } = await load();
    const drive = parts(getLinkDriveAuthUrl("user-1")).params;
    const calendar = parts(gmail.getLinkCalendarAuthUrl("s")).params;
    expect(drive.client_id).toBe(calendar.client_id);
    expect(drive.redirect_uri).toBe(calendar.redirect_uri);
  });

  it("signs a 10-minute state naming the user and the __link_drive__ marker", async () => {
    const { getLinkDriveAuthUrl, verifyToken, DRIVE_LINK_STATE_MARKER } = await load();
    const state = parts(getLinkDriveAuthUrl("user-1")).params.state ?? "";
    const payload = verifyToken(state) as {
      userId: string;
      email: string;
      iat: number;
      exp: number;
    };
    expect(DRIVE_LINK_STATE_MARKER).toBe("__link_drive__");
    expect(payload.userId).toBe("user-1");
    expect(payload.email).toBe("__link_drive__");
    expect(payload.exp - payload.iat).toBe(600);
  });
});
