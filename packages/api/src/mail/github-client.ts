/**
 * GitHub Notifications API client — the only networked piece of the GitHub
 * attention source. BYO personal access token (scope: notifications, or
 * repo for private). Parses the API response into the source-agnostic
 * GitHubNotification shape that github-source.ts maps into the judge.
 */

import type { GitHubNotification } from "./github-source.js";

const API_BASE = "https://api.github.com";
const COMMON_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "klorn-attention-firewall",
};

interface RawNotification {
  id: string;
  reason: string;
  updated_at: string;
  repository?: { full_name?: string };
  subject?: { title?: string; type?: string; url?: string | null };
}

/**
 * Turn a Notifications API subject url (…/repos/{o}/{r}/pulls/{n} or
 * …/issues/{n}) into the browser html url. Returns null for shapes we
 * can't resolve (CheckSuite, Release, Discussion, null) rather than
 * guessing — a wrong link is worse than no link.
 */
export function resolveHtmlUrl(apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  const m = apiUrl.match(/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)/);
  if (!m) return null;
  const [, owner, repo, kind, num] = m;
  const path = kind === "pulls" ? "pull" : "issues";
  return `https://github.com/${owner}/${repo}/${path}/${num}`;
}

async function fail(res: Response): Promise<never> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    detail = body?.message ? `: ${body.message}` : "";
  } catch {
    /* ignore parse error */
  }
  throw new Error(`GitHub API ${res.status}${detail}`);
}

/** Validate a PAT by calling /user. Never throws — returns a result. */
export async function verifyGitHubToken(
  token: string,
): Promise<{ ok: true; login: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${API_BASE}/user`, {
      headers: { ...COMMON_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, message: body?.message ?? `GitHub API ${res.status}` };
    }
    const body = (await res.json()) as { login?: string };
    return { ok: true, login: body.login ?? "unknown" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "network error" };
  }
}

/**
 * Fetch unread notifications, optionally since a cursor. Throws on a
 * non-2xx response so the scheduler can record the failure and NOT advance
 * its cursor (the window must not be silently lost).
 */
export async function fetchGitHubNotifications(
  token: string,
  since?: Date,
): Promise<GitHubNotification[]> {
  const params = new URLSearchParams({ all: "false" });
  if (since) params.set("since", since.toISOString());

  const res = await fetch(`${API_BASE}/notifications?${params.toString()}`, {
    headers: { ...COMMON_HEADERS, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) await fail(res);

  const raw = (await res.json()) as RawNotification[];
  if (!Array.isArray(raw)) return [];

  return raw.map((n) => ({
    id: n.id,
    reason: n.reason ?? "subscribed",
    repo: n.repository?.full_name ?? "unknown/unknown",
    subjectTitle: n.subject?.title ?? "",
    subjectType: n.subject?.type ?? "Unknown",
    url: resolveHtmlUrl(n.subject?.url),
    updatedAt: new Date(n.updated_at),
  }));
}
