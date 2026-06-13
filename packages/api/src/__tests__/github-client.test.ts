/**
 * github-client — the only networked piece. Parses the GitHub Notifications
 * API into the source-agnostic GitHubNotification shape and verifies a PAT.
 * fetch is stubbed; no real network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubNotifications, verifyGitHubToken } from "../github-client.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

const RAW_PR_NOTIF = {
  id: "thread-1",
  reason: "review_requested",
  updated_at: "2026-06-13T09:00:00Z",
  repository: { full_name: "k08200/klorn" },
  subject: {
    title: "Fix the auth flow",
    type: "PullRequest",
    url: "https://api.github.com/repos/k08200/klorn/pulls/123",
  },
};

describe("fetchGitHubNotifications", () => {
  it("parses notifications and resolves the API url to an html url", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([RAW_PR_NOTIF]));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchGitHubNotifications("tok");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "thread-1",
      reason: "review_requested",
      repo: "k08200/klorn",
      subjectTitle: "Fix the auth flow",
      subjectType: "PullRequest",
      url: "https://github.com/k08200/klorn/pull/123",
    });
    expect(out[0].updatedAt.toISOString()).toBe("2026-06-13T09:00:00.000Z");

    // Auth header + the notifications endpoint.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/notifications");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer tok");
  });

  it("passes the since cursor through as a query param", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await fetchGitHubNotifications("tok", new Date("2026-06-13T00:00:00Z"));
    expect(String(fetchMock.mock.calls[0][0])).toContain("since=2026-06-13T00%3A00%3A00.000Z");
  });

  it("maps an Issue subject url to its html url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            ...RAW_PR_NOTIF,
            subject: {
              title: "Bug: crash",
              type: "Issue",
              url: "https://api.github.com/repos/k08200/klorn/issues/9",
            },
          },
        ]),
      ),
    );
    const out = await fetchGitHubNotifications("tok");
    expect(out[0].url).toBe("https://github.com/k08200/klorn/issues/9");
  });

  it("leaves url null when the subject url is not resolvable (e.g. CheckSuite)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { ...RAW_PR_NOTIF, subject: { title: "CI failed", type: "CheckSuite", url: null } },
        ]),
      ),
    );
    const out = await fetchGitHubNotifications("tok");
    expect(out[0].url).toBeNull();
  });

  it("throws on a non-2xx response so the scheduler records the failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401)),
    );
    await expect(fetchGitHubNotifications("bad")).rejects.toThrow(/401|credential/i);
  });
});

describe("verifyGitHubToken", () => {
  it("returns ok + login for a valid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ login: "k08200" })),
    );
    expect(await verifyGitHubToken("tok")).toEqual({ ok: true, login: "k08200" });
  });

  it("returns not-ok with a message for a rejected token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401)),
    );
    const result = await verifyGitHubToken("bad");
    expect(result.ok).toBe(false);
  });
});
