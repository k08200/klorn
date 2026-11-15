/**
 * A link back to the Slack message (docs/providers/slack.md §9), built locally
 * in the form Slack's own chat.getPermalink returns
 * (https://docs.slack.dev/reference/methods/chat.getPermalink):
 * `https://<workspace>.slack.com/archives/<channel>/p<ts without the dot>`,
 * plus `?thread_ts=…&cid=…` for a thread reply. No API call, so no token.
 */

/** The workspace origin when it is https on slack.com, else null. */
function slackOrigin(workspaceUrl: string | null): string | null {
  if (!workspaceUrl) return null;
  try {
    const url = new URL(workspaceUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && host.endsWith(".slack.com") ? url.origin : null;
  } catch {
    return null;
  }
}

export function slackPermalink(
  workspaceUrl: string | null,
  channel: string,
  ts: string,
  threadTs: string | null,
): string | null {
  const origin = slackOrigin(workspaceUrl);
  if (!origin) return null;
  const base = `${origin}/archives/${encodeURIComponent(channel)}/p${ts.replace(".", "")}`;
  if (!threadTs || threadTs === ts) return base;
  const query = new URLSearchParams({ thread_ts: threadTs, cid: channel });
  return `${base}?${query.toString()}`;
}
