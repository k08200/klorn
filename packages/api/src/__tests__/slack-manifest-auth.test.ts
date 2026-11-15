/**
 * Slack v1 app manifest and the connect-time token check
 * (docs/providers/slack.md §4): user token only, four read scopes, and a
 * token holding any other scope is refused so a write-capable token is never
 * stored.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGrantedScopes, slackAuthTest } from "../slack/auth-test.js";
import {
  MANIFEST_PLACEHOLDER_URL,
  renderSlackManifest,
  SLACK_USER_EVENTS,
  SLACK_USER_SCOPES,
  slackEventsUrl,
} from "../slack/manifest.js";

const repoManifest = () =>
  readFileSync(new URL("../../../../integrations/slack/manifest.yaml", import.meta.url), "utf8");

afterEach(() => {
  delete process.env.PUBLIC_URL;
  delete process.env.RENDER_EXTERNAL_URL;
});

describe("Slack manifest", () => {
  it("the manifest shipped in integrations/slack is the rendered template", () => {
    expect(repoManifest()).toBe(renderSlackManifest(MANIFEST_PLACEHOLDER_URL));
  });

  it("asks for user scopes only, read-only, with a matching user event each", () => {
    expect([...SLACK_USER_SCOPES]).toEqual([
      "im:history",
      "mpim:history",
      "channels:history",
      "groups:history",
    ]);
    expect([...SLACK_USER_EVENTS]).toEqual([
      "message.im",
      "message.mpim",
      "message.channels",
      "message.groups",
    ]);
    const yaml = repoManifest();
    expect(yaml).not.toMatch(/write|bot_user|bot_events|\bbot:/);
    expect(yaml).toContain("token_rotation_enabled: false");
    expect(yaml).toContain("socket_mode_enabled: false");
  });

  it("puts this connection's Request URL, on the API's public origin, in the manifest", () => {
    process.env.PUBLIC_URL = "https://klorn.example.com/ignored/path";
    const url = slackEventsUrl("a".repeat(32));
    expect(url).toBe(`https://klorn.example.com/api/slack/events/${"a".repeat(32)}`);
    expect(renderSlackManifest(url ?? "")).toContain(`request_url: ${url}`);
  });

  it("uses RENDER_EXTERNAL_URL when PUBLIC_URL is unset, as the phone webhooks do", () => {
    process.env.RENDER_EXTERNAL_URL = "https://klorn-api.onrender.com";
    expect(slackEventsUrl("c".repeat(32))).toBe(
      `https://klorn-api.onrender.com/api/slack/events/${"c".repeat(32)}`,
    );
  });

  it("has no Request URL rather than a wrong one when the public origin is unset or unusable", () => {
    expect(slackEventsUrl("b".repeat(32))).toBeNull();
    process.env.PUBLIC_URL = "javascript:alert(1)";
    expect(slackEventsUrl("b".repeat(32))).toBeNull();
  });
});

describe("checkGrantedScopes", () => {
  it("accepts the full set and any subset that still has im:history", () => {
    expect(checkGrantedScopes([...SLACK_USER_SCOPES])).toEqual({ ok: true });
    expect(checkGrantedScopes(["im:history"])).toEqual({ ok: true });
  });

  it("refuses a token without im:history", () => {
    expect(checkGrantedScopes(["channels:history"])).toEqual({
      ok: false,
      code: "missing-scopes",
      scopes: ["im:history"],
    });
  });

  it("refuses a token with any scope Klorn does not ask for", () => {
    expect(checkGrantedScopes(["im:history", "chat:write", "users:read"])).toEqual({
      ok: false,
      code: "extra-scopes",
      scopes: ["chat:write", "users:read"],
    });
  });

  it("never echoes a scope name that is not plain scope syntax", () => {
    const result = checkGrantedScopes(["im:history", "<script>", "x".repeat(500)]);
    expect(result).toEqual({ ok: false, code: "extra-scopes", scopes: ["(unrecognized)"] });
  });
});

describe("slackAuthTest", () => {
  const TOKEN = "xoxp-1234-5678-abcdef";
  const respond = (
    body: unknown,
    scopes: string | null = SLACK_USER_SCOPES.join(","),
    status = 200,
  ) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: scopes === null ? {} : { "x-oauth-scopes": scopes },
        }),
    );

  it("returns the team, user and workspace URL for a good token", async () => {
    const fetchImpl = respond({
      ok: true,
      url: "https://acme.slack.com/",
      team: "Acme",
      user: "me",
      team_id: "T0001",
      user_id: "U0001",
    });
    const result = await slackAuthTest(TOKEN, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({
      ok: true,
      teamId: "T0001",
      slackUserId: "U0001",
      workspaceUrl: "https://acme.slack.com/",
      scopes: [...SLACK_USER_SCOPES],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/auth.test");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("maps Slack's invalid_auth to a token error without echoing Slack's body", async () => {
    const result = await slackAuthTest(
      TOKEN,
      respond({ ok: false, error: "invalid_auth" }) as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, code: "slack-rejected-token" });
  });

  it("refuses a workspace URL that is not a slack.com https origin", async () => {
    const result = await slackAuthTest(
      TOKEN,
      respond({
        ok: true,
        url: "https://evil.example.com/",
        team_id: "T0001",
        user_id: "U0001",
      }) as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, code: "bad-response" });
  });

  it("refuses a token carrying write scopes", async () => {
    const result = await slackAuthTest(
      TOKEN,
      respond(
        { ok: true, url: "https://acme.slack.com/", team_id: "T0001", user_id: "U0001" },
        "im:history,chat:write",
      ) as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, code: "extra-scopes", scopes: ["chat:write"] });
  });

  it("reports Slack unreachable on a network error or a 5xx", async () => {
    const boom = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    });
    expect(await slackAuthTest(TOKEN, boom as unknown as typeof fetch)).toEqual({
      ok: false,
      code: "slack-unreachable",
    });
    expect(await slackAuthTest(TOKEN, respond({}, null, 503) as unknown as typeof fetch)).toEqual({
      ok: false,
      code: "slack-unreachable",
    });
  });
});
