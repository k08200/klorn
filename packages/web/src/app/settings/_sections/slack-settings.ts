// Settings → Integrations → Slack (docs/providers/slack.md §5, §15): pure
// helpers for the panel, free of React so packages/api can test them.

export type SlackConnectionStatus =
  | { state: "none" }
  | {
      state: "pending" | "connected";
      requestUrl: string | null;
      teamId: string | null;
      workspaceUrl: string | null;
      optInChannelIds: string[];
      credentialsSetAt: string | null;
      lastEventAt: string | null;
    };

/** The panel shows only while the API's SLACK_ENABLED opens Slack to this user (/me user.slack). */
export function slackPanelVisible(user: { slack?: boolean } | null | undefined): boolean {
  return user?.slack === true;
}

const MAX_CHANNEL_TEXT = 2000;

/** Channel ids from free text: commas, spaces or new lines between them; duplicates dropped. */
export function parseChannelIds(text: string): string[] {
  const ids = text
    .slice(0, MAX_CHANNEL_TEXT)
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return [...new Set(ids)];
}

const KNOWN_ERRORS = new Set([
  "invalid-signing-secret",
  "bot-token",
  "invalid-user-token",
  "slack-rejected-token",
  "slack-unreachable",
  "bad-response",
  "missing-scopes",
  "extra-scopes",
  "invalid-channels",
  "public-url-missing",
  "not-started",
  "rate-limited",
]);

export interface SlackFailure {
  key: string;
  vars?: Record<string, string>;
}

/** The i18n key (and scope list) for an API error thrown by apiFetch ("API <status>: <body>"). */
export function slackFailure(error: unknown): SlackFailure {
  const message = error instanceof Error ? error.message : "";
  const json = message.slice(message.indexOf("{"));
  try {
    const body = JSON.parse(json) as { code?: unknown; scopes?: unknown };
    const code = typeof body.code === "string" && KNOWN_ERRORS.has(body.code) ? body.code : null;
    if (!code) return { key: "slack.error.generic" };
    const scopes = Array.isArray(body.scopes)
      ? body.scopes
          .filter((s): s is string => typeof s === "string")
          .slice(0, 20)
          .map((s) => s.slice(0, 64))
          .join(", ")
      : "";
    return scopes
      ? { key: `slack.error.${code}`, vars: { scopes } }
      : { key: `slack.error.${code}` };
  } catch {
    return { key: "slack.error.generic" };
  }
}

/** "acme.slack.com" from the workspace URL, or null. */
export function slackWorkspaceHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
