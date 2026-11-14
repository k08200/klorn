/**
 * Connect-time check of a Slack user token: `auth.test` (no scope needed,
 * https://docs.slack.dev/reference/methods/auth.test) returns the team, the
 * Slack user and the workspace URL, and its `x-oauth-scopes` header lists the
 * scopes the token holds. A token without im:history, or with any scope the
 * manifest does not ask for, is refused: Klorn never stores a token that
 * could write to Slack. The only Slack Web API call Klorn makes.
 */

import { SLACK_REQUIRED_SCOPES, SLACK_USER_SCOPES } from "./manifest.js";

const AUTH_TEST_URL = "https://slack.com/api/auth.test";
const AUTH_TEST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_CHARS = 64 * 1024;
const MAX_SCOPE_NAME = 64;
const MAX_REPORTED_SCOPES = 20;
const MAX_ID = 40;

export type SlackScopeCheck =
  | { ok: true }
  | { ok: false; code: "missing-scopes" | "extra-scopes"; scopes: string[] };

export type SlackAuthResult =
  | { ok: true; teamId: string; slackUserId: string; workspaceUrl: string; scopes: string[] }
  | { ok: false; code: "slack-rejected-token" | "slack-unreachable" | "bad-response" }
  | { ok: false; code: "missing-scopes" | "extra-scopes"; scopes: string[] };

/** A scope name safe to show back to the user, or a fixed stand-in. */
function displayScope(scope: string): string {
  if (scope.length === 0 || scope.length > MAX_SCOPE_NAME) return "(unrecognized)";
  for (let i = 0; i < scope.length; i++) {
    const c = scope.charAt(i);
    const ok = (c >= "a" && c <= "z") || c === ":" || c === "." || c === "_" || c === "-";
    if (!ok) return "(unrecognized)";
  }
  return scope;
}

export function checkGrantedScopes(granted: readonly string[]): SlackScopeCheck {
  const allowed = new Set<string>(SLACK_USER_SCOPES);
  const missing = SLACK_REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) return { ok: false, code: "missing-scopes", scopes: [...missing] };
  const extra = granted.filter((scope) => !allowed.has(scope));
  if (extra.length === 0) return { ok: true };
  const shown = [...new Set(extra.map(displayScope))].slice(0, MAX_REPORTED_SCOPES);
  return { ok: false, code: "extra-scopes", scopes: shown };
}

function parseScopes(header: string | null): string[] {
  if (!header) return [];
  return header
    .slice(0, MAX_RESPONSE_CHARS)
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/** `https://<workspace>.slack.com/` (Enterprise Grid included), else null. */
function workspaceOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !host.endsWith(".slack.com")) return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? value : null;
}

async function callAuthTest(token: string, fetchImpl: typeof fetch): Promise<Response | null> {
  try {
    return await fetchImpl(AUTH_TEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      signal: AbortSignal.timeout(AUTH_TEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

export async function slackAuthTest(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackAuthResult> {
  const response = await callAuthTest(token, fetchImpl);
  if (!response || !response.ok) return { ok: false, code: "slack-unreachable" };
  let body: Record<string, unknown>;
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) return { ok: false, code: "bad-response" };
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "bad-response" };
  }
  if (body?.ok !== true) return { ok: false, code: "slack-rejected-token" };
  const teamId = boundedId(body.team_id);
  const slackUserId = boundedId(body.user_id);
  const workspaceUrl = workspaceOrigin(body.url);
  if (!teamId || !slackUserId || !workspaceUrl) return { ok: false, code: "bad-response" };
  const scopes = parseScopes(response.headers.get("x-oauth-scopes"));
  const scopeCheck = checkGrantedScopes(scopes);
  if (!scopeCheck.ok) return scopeCheck;
  return { ok: true, teamId, slackUserId, workspaceUrl, scopes };
}
