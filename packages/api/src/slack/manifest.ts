/**
 * The Slack app manifest for Klorn's internal, read-only Slack app
 * (docs/providers/slack.md §4; schema https://docs.slack.dev/reference/app-manifest).
 * integrations/slack/manifest.yaml is this template rendered with the
 * placeholder Request URL (a test keeps the two equal); GET
 * /api/slack/manifest renders it with the user's own Request URL.
 *
 * User token only, no bot user: a bot cannot see a DM between the user and
 * another person. Four history scopes, one user event each, nothing that
 * writes. The connect route refuses a token holding any other scope.
 */

import { publicBaseUrl } from "../notify/phone-twiml.js";

export const SLACK_USER_SCOPES = [
  "im:history",
  "mpim:history",
  "channels:history",
  "groups:history",
] as const;

/** The one scope a connection cannot work without: DMs to the user. */
export const SLACK_REQUIRED_SCOPES = ["im:history"] as const;

export const SLACK_USER_EVENTS = [
  "message.im",
  "message.mpim",
  "message.channels",
  "message.groups",
] as const;

export const MANIFEST_PLACEHOLDER_URL = "https://YOUR-KLORN-API/api/slack/events/YOUR-HOOK-ID";

/**
 * The Request URL Slack calls for this connection, on the API's public origin
 * (PUBLIC_URL, else RENDER_EXTERNAL_URL — the same origin the phone webhooks
 * use). Null when that origin is unset or not an http(s) URL: a self-hoster
 * must set it rather than get a manifest pointing at someone else's API.
 */
export function slackEventsUrl(hookId: string): string | null {
  const base = publicBaseUrl();
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}/api/slack/events/${hookId}`;
  } catch {
    return null;
  }
}

const list = (items: readonly string[], indent: string) =>
  items.map((item) => `${indent}- ${item}`).join("\n");

export function renderSlackManifest(requestUrl: string): string {
  return `# Klorn — internal Slack app, read-only (docs/providers/slack.md).
# Create it at https://api.slack.com/apps → Create New App → From a manifest.
# Replace the request_url with the one Klorn shows in Settings → Integrations →
# Slack (or download this manifest from there, already filled in).
display_information:
  name: Klorn (read-only)
  description: Judges your Slack DMs and mentions into Klorn's lanes. Never posts.
  background_color: "#1d1d1f"
oauth_config:
  scopes:
    user:
${list(SLACK_USER_SCOPES, "      ")}
settings:
  event_subscriptions:
    request_url: ${requestUrl}
    user_events:
${list(SLACK_USER_EVENTS, "      ")}
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}
