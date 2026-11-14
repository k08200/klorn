/**
 * Slack v1 ingest building blocks (docs/providers/slack.md §6, §12): request
 * signing, envelope parsing, the keep/drop filter and Slack text handling.
 * Pure functions, no database.
 */

import { describe, expect, it } from "vitest";
import { parseSlackEnvelope, type SlackEventCallback } from "../slack/envelope.js";
import { decideSlackEvent, type SlackFilterConnection } from "../slack/event-filter.js";
import {
  SLACK_MAX_SKEW_SECONDS,
  signSlackRequest,
  verifySlackSignature,
} from "../slack/signature.js";
import {
  capSlackText,
  mentionsSlackUser,
  SLACK_MAX_TEXT,
  sanitizeSlackText,
  slackPlainText,
} from "../slack/text.js";
import { expectLinear, fastestCpuMs, MB, repeatTo } from "./helpers/linear-timing.js";

const SECRET = "8f742231b10e8888abcd99eeeeee85a5";
const NOW_MS = 1_763_100_000_000;
const NOW_S = String(Math.floor(NOW_MS / 1000));

describe("verifySlackSignature", () => {
  const body = Buffer.from('{"type":"url_verification","challenge":"abc"}');
  const signed = (timestamp = NOW_S, raw: Buffer = body, secret = SECRET) =>
    signSlackRequest(raw, timestamp, secret);

  it("accepts Slack's v0 HMAC-SHA256 over v0:timestamp:body", () => {
    expect(
      verifySlackSignature({
        rawBody: body,
        timestamp: NOW_S,
        signature: signed(),
        signingSecret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: true });
  });

  it("matches Slack's documented example signature", () => {
    // https://docs.slack.dev/authentication/verifying-requests-from-slack
    const raw = Buffer.from(
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
    );
    expect(signSlackRequest(raw, "1531420618", "8f742231b10e8888abcd99yyyzzz85a5")).toBe(
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    );
  });

  it("rejects a signature made with another secret", () => {
    const result = verifySlackSignature({
      rawBody: body,
      timestamp: NOW_S,
      signature: signed(NOW_S, body, "another-secret-another-secret-00"),
      signingSecret: SECRET,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a body changed after signing", () => {
    const result = verifySlackSignature({
      rawBody: Buffer.from('{"type":"url_verification","challenge":"abd"}'),
      timestamp: NOW_S,
      signature: signed(),
      signingSecret: SECRET,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a timestamp more than five minutes old or ahead, even when correctly signed", () => {
    for (const offset of [SLACK_MAX_SKEW_SECONDS + 1, -(SLACK_MAX_SKEW_SECONDS + 1)]) {
      const ts = String(Number(NOW_S) - offset);
      const result = verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: signed(ts),
        signingSecret: SECRET,
        nowMs: NOW_MS,
      });
      expect(result).toEqual({ ok: false, reason: "stale-timestamp" });
    }
  });

  it("accepts a timestamp right at the edge of the window", () => {
    const ts = String(Number(NOW_S) - SLACK_MAX_SKEW_SECONDS);
    expect(
      verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: signed(ts),
        signingSecret: SECRET,
        nowMs: NOW_MS,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["no timestamp", undefined, "v0=abc"],
    ["no signature", NOW_S, undefined],
    ["an empty signature", NOW_S, ""],
    ["a non-numeric timestamp", "12a", "v0=abc"],
    ["an absurdly long timestamp", "1".repeat(40), "v0=abc"],
    ["a signature without the v0= prefix", NOW_S, "v1=abc"],
  ])("rejects %s as missing headers", (_label, timestamp, signature) => {
    const result = verifySlackSignature({
      rawBody: body,
      timestamp,
      signature,
      signingSecret: SECRET,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing-headers" });
  });

  it("refuses to verify against an empty signing secret", () => {
    const result = verifySlackSignature({
      rawBody: body,
      timestamp: NOW_S,
      signature: signSlackRequest(body, NOW_S, ""),
      signingSecret: "",
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(false);
  });
});

const message = (event: Record<string, unknown>, envelope: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "event_callback",
    team_id: "T0001",
    api_app_id: "A0001",
    event_id: "Ev0ABCDEF12",
    event_time: 1_763_100_000,
    authorizations: [{ team_id: "T0001", user_id: "UME", is_bot: false }],
    event: {
      type: "message",
      channel: "D0DM",
      channel_type: "im",
      user: "UOTHER",
      text: "can you review the deck today?",
      ts: "1763100000.000100",
      ...event,
    },
    ...envelope,
  });

describe("parseSlackEnvelope", () => {
  it("reads a url_verification challenge", () => {
    expect(parseSlackEnvelope('{"type":"url_verification","challenge":"3eZbrw1aBm2"}')).toEqual({
      kind: "url_verification",
      challenge: "3eZbrw1aBm2",
    });
  });

  it("reads an event_callback message", () => {
    const parsed = parseSlackEnvelope(message({ thread_ts: "1763099990.000050" }));
    expect(parsed).toMatchObject({
      kind: "event_callback",
      eventId: "Ev0ABCDEF12",
      teamId: "T0001",
      authorizedUserIds: ["UME"],
      isExtShared: false,
      event: {
        channel: "D0DM",
        channelType: "im",
        user: "UOTHER",
        ts: "1763100000.000100",
        threadTs: "1763099990.000050",
        text: "can you review the deck today?",
        isBot: false,
      },
    });
  });

  it("reads app_rate_limited", () => {
    expect(
      parseSlackEnvelope(
        '{"type":"app_rate_limited","team_id":"T0001","minute_rate_limited":1518467820,"api_app_id":"A0001"}',
      ),
    ).toEqual({ kind: "app_rate_limited" });
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["no type", "{}"],
    ["an unknown type", '{"type":"block_actions"}'],
    ["a challenge that is not a string", '{"type":"url_verification","challenge":7}'],
    [
      "an oversize challenge",
      JSON.stringify({ type: "url_verification", challenge: "a".repeat(600) }),
    ],
    ["an event without event_id", message({}, { event_id: undefined })],
    ["a malformed event_id", message({}, { event_id: "../../etc" })],
    ["a malformed team_id", message({}, { team_id: "x".repeat(200) })],
  ])("treats %s as invalid", (_label, raw) => {
    expect(parseSlackEnvelope(raw).kind).toBe("invalid");
  });

  it("caps message text and never keeps more than SLACK_MAX_TEXT characters", () => {
    const parsed = parseSlackEnvelope(message({ text: "x".repeat(SLACK_MAX_TEXT * 3) }));
    expect(parsed.kind).toBe("event_callback");
    expect((parsed as SlackEventCallback).event?.text.length).toBe(SLACK_MAX_TEXT);
  });

  it("marks bot authorship from bot_id or bot_profile, not only the subtype", () => {
    const viaId = parseSlackEnvelope(message({ bot_id: "B01" })) as SlackEventCallback;
    const viaProfile = parseSlackEnvelope(
      message({ bot_profile: { id: "B01" } }),
    ) as SlackEventCallback;
    expect(viaId.event?.isBot).toBe(true);
    expect(viaProfile.event?.isBot).toBe(true);
  });

  it("keeps a non-message event as an event_callback with no message", () => {
    const parsed = parseSlackEnvelope(
      message({ type: "reaction_added", channel: undefined }),
    ) as SlackEventCallback;
    expect(parsed.kind).toBe("event_callback");
    expect(parsed.event).toBeNull();
  });
});

describe("decideSlackEvent", () => {
  const conn: SlackFilterConnection = {
    teamId: "T0001",
    slackUserId: "UME",
    optInChannelIds: ["C0OPTIN"],
  };
  const decide = (event: Record<string, unknown>, envelope: Record<string, unknown> = {}) =>
    decideSlackEvent(parseSlackEnvelope(message(event, envelope)) as SlackEventCallback, conn);

  it("keeps a DM and a group DM", () => {
    expect(decide({})).toEqual({ action: "keep", kind: "dm", mentionsUser: false });
    expect(decide({ channel: "G0MPIM", channel_type: "mpim" })).toMatchObject({
      action: "keep",
      kind: "group_dm",
    });
  });

  it("keeps a channel message only when it mentions the user or the channel is opted in", () => {
    expect(decide({ channel: "C0PUB", channel_type: "channel" })).toEqual({
      action: "drop",
      reason: "not-relevant",
    });
    expect(
      decide({ channel: "C0PUB", channel_type: "channel", text: "<@UME> can you look?" }),
    ).toEqual({ action: "keep", kind: "mention", mentionsUser: true });
    expect(
      decide({ channel: "G0PRIV", channel_type: "group", text: "ping <@UME|me>" }),
    ).toMatchObject({ action: "keep", kind: "mention" });
    expect(decide({ channel: "C0OPTIN", channel_type: "channel" })).toEqual({
      action: "keep",
      kind: "opt_in",
      mentionsUser: false,
    });
  });

  it("does not count a mention of someone whose id merely starts with the user's", () => {
    expect(
      decide({ channel: "C0PUB", channel_type: "channel", text: "<@UMEX> look" }),
    ).toMatchObject({ action: "drop" });
  });

  it("treats the user's own message as an answer, never as something to judge", () => {
    expect(decide({ user: "UME" })).toEqual({ action: "own" });
  });

  it.each([
    ["a bot message", { bot_id: "B01" }, "bot"],
    ["a bot_message subtype", { subtype: "bot_message" }, "bot"],
    ["a channel join", { subtype: "channel_join" }, "subtype"],
    ["an edit", { subtype: "message_changed" }, "subtype"],
    ["a message without a user", { user: undefined }, "no-user"],
    ["an empty message", { text: "   " }, "empty"],
  ])("drops %s", (_label, event, reason) => {
    expect(decide(event)).toEqual({ action: "drop", reason });
  });

  it("keeps thread broadcasts and file shares (text only)", () => {
    expect(decide({ subtype: "thread_broadcast" }).action).toBe("keep");
    expect(decide({ subtype: "file_share" }).action).toBe("keep");
  });

  it("turns message_deleted into a delete of Klorn's copy", () => {
    expect(
      decide({ subtype: "message_deleted", user: undefined, text: "", deleted_ts: "1763.000001" }),
    ).toEqual({ action: "delete", ts: "1763.000001" });
  });

  it("drops another team's event, one not visible to this user, and Slack Connect", () => {
    expect(decide({}, { team_id: "T9999" })).toEqual({ action: "drop", reason: "team-mismatch" });
    expect(
      decide({}, { authorizations: [{ team_id: "T0001", user_id: "USOMEONE", is_bot: false }] }),
    ).toEqual({ action: "drop", reason: "not-authorized-user" });
    expect(decide({}, { is_ext_shared_channel: true })).toEqual({
      action: "drop",
      reason: "ext-shared",
    });
  });

  it("drops a non-message event", () => {
    expect(decide({ type: "reaction_added" })).toEqual({ action: "drop", reason: "not-message" });
  });
});

describe("Slack text", () => {
  it("detects a mention of exactly this user", () => {
    expect(mentionsSlackUser("hi <@U123> there", "U123")).toBe(true);
    expect(mentionsSlackUser("hi <@U123|bob>", "U123")).toBe(true);
    expect(mentionsSlackUser("hi <@U1234>", "U123")).toBe(false);
    expect(mentionsSlackUser("hi @U123", "U123")).toBe(false);
  });

  it("drops NUL and replaces lone surrogates so Postgres can always store the text", () => {
    expect(sanitizeSlackText("a\u0000b")).toBe("ab");
    expect(sanitizeSlackText("x\ud800y\udc00z")).toBe("x\ufffdy\ufffdz");
    expect(sanitizeSlackText("ok 😀")).toBe("ok 😀");
    const parsed = parseSlackEnvelope(message({ text: "hi\u0000\ud800" })) as SlackEventCallback;
    expect(parsed.event?.text).toBe("hi\ufffd");
  });

  it("caps text without leaving half a surrogate pair", () => {
    const capped = capSlackText(`${"a".repeat(9)}😀`, 10);
    expect(capped).toBe("a".repeat(9));
    expect(capSlackText("short", 10)).toBe("short");
  });

  it("renders Slack markup as plain text", () => {
    expect(
      slackPlainText(
        "<@U123> see <https://example.com/a|the doc> in <#C123|general> &amp; <!here> &lt;b&gt;",
        200,
      ),
    ).toBe("@someone see the doc in #general & @here <b>");
    expect(slackPlainText("link <https://example.com/x>", 200)).toBe("link https://example.com/x");
    expect(slackPlainText("a\n\n  b\tc", 200)).toBe("a b c");
    expect(slackPlainText("unclosed <@U1 and more", 200)).toBe("unclosed <@U1 and more");
  });

  it("stays linear on adversarial markup", () => {
    expectLinear(
      (bytes) => repeatTo(bytes, "<<@|<#|<!|&amp"),
      (input) => slackPlainText(input, 4 * MB),
    );
    const mentionMs = fastestCpuMs(() => mentionsSlackUser(repeatTo(MB, "<@U12"), "U123"));
    expect(mentionMs).toBeLessThan(1000);
  });
});
