/**
 * joinMeeting's host allowlist sits behind the https-only gate: every link the
 * server now hands on (safeMeetingLink's normalised output) still opens when its
 * host is a meeting platform, and a link that passes the gate on a host that is
 * not one is still refused. `open` is mocked; macOS is pinned so the check runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: m.execFile }));
vi.mock("googleapis", () => ({ google: { calendar: vi.fn() } }));
vi.mock("../mail/gmail.js", () => ({ getAuthedClient: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../llm/openai.js", () => ({ createCompletion: vi.fn(), MODEL: {} }));
vi.mock("../db.js", () => ({ prisma: {} }));

import { safeMeetingLink } from "../pim/meeting-link.js";

const realPlatform = process.platform;
let joinMeeting: typeof import("../pim/meeting.js").joinMeeting;

beforeAll(async () => {
  // IS_MACOS is read when the module loads.
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.resetModules();
  ({ joinMeeting } = await import("../pim/meeting.js"));
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
});

beforeEach(() => {
  m.execFile.mockReset();
  m.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: object) => void) =>
      cb(null, { stdout: "", stderr: "" }),
  );
});

function gated(raw: string): string {
  const link = safeMeetingLink(raw);
  if (link === null) throw new Error(`expected ${raw} to pass the gate`);
  return link;
}

describe("joinMeeting opens a gated link on a meeting platform", () => {
  it.each([
    "https://meet.google.com/abc-defg-hij",
    "HTTPS://Meet.Google.com/abc-defg-hij",
    "https://zoom.us/j/123?pwd=x",
    "https://us02web.zoom.us/j/851?pwd=abc",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
    // A description link with trailing punctuation, as the regex lifts it.
    "https://meet.google.com/abc-defg-hij>",
  ])("%s", async (raw) => {
    const link = gated(raw);

    const result = await joinMeeting(link);

    expect(result).toEqual({ success: true, link });
    expect(m.execFile).toHaveBeenCalledTimes(1);
    expect(m.execFile.mock.calls[0]?.slice(0, 2)).toEqual(["open", [link]]);
  });
});

describe("joinMeeting still refuses a gated link on any other host", () => {
  it.each([
    // The description's Zoom pattern allows anything before "zoom.us/".
    ["a host that only mentions zoom.us", "https://evil.example/?zoom.us/x", "evil.example"],
    [
      "a look-alike host",
      "https://meet.google.com.evil.example/abc",
      "meet.google.com.evil.example",
    ],
  ])("%s", async (_label, raw, host) => {
    const result = await joinMeeting(gated(raw));

    expect(result).toMatchObject({
      success: false,
      error: `Unrecognized meeting platform: ${host}`,
    });
    expect(m.execFile).not.toHaveBeenCalled();
  });

  it("refuses an http link the gate would have dropped, if one ever reaches it", async () => {
    expect(safeMeetingLink("http://meet.google.com/abc-defg-hij")).toBeNull();

    const result = await joinMeeting("http://meet.google.com/abc-defg-hij");

    expect(result).toMatchObject({ success: false, error: "Only HTTPS meeting links are allowed" });
    expect(m.execFile).not.toHaveBeenCalled();
  });
});
