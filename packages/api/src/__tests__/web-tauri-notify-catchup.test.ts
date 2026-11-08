/**
 * The Windows desktop shell's catch-up orchestration
 * (packages/web/src/lib/native/tauri-notify.ts, decision N6): the
 * side-effecting edge around the pure planner. Two bells (rail + sidebar)
 * refetch together, so two passes run at once; each id may toast only once,
 * and quiet hours back the questions off.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const tauriInvoke = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../../web/src/lib/api", () => ({ apiFetch }));
vi.mock("../../../web/src/lib/sentry", () => ({ captureClientError: vi.fn() }));
vi.mock("../../../web/src/lib/native/shell", () => ({
  shellKind: () => "tauri",
  tauriInvoke,
}));

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const HOUR = 3_600_000;
const SUMMARY = "{count} urgent emails while Klorn was closed";

function mailRow(id: string) {
  return {
    id,
    type: "email",
    title: "Urgent email",
    message: "Kim: x [gm]",
    sourceEmailId: `mail-${id}`,
    isRead: false,
    createdAt: new Date(NOW - HOUR).toISOString(),
  };
}

function missed(id: string, sender: string) {
  return {
    id,
    emailId: `mail-${id}`,
    title: sender,
    body: "Subject",
    createdAt: new Date(NOW - HOUR).toISOString(),
  };
}

/** Routes the two GETs a pass makes. */
function serve(catchUp: unknown) {
  apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/notifications/desktop-catchup")) return catchUp;
    if (url === "/api/automations") return {};
    throw new Error(`unexpected ${url}`);
  });
}

async function freshModule() {
  vi.resetModules();
  return import("../../../web/src/lib/native/tauri-notify");
}

const banners = () =>
  tauriInvoke.mock.calls.filter((c) => (c as unknown[])[0] === "show_banner").map((c) => c[1]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  apiFetch.mockReset();
  tauriInvoke.mockClear();
});

describe("catchUpDesktopAlerts — urgent mail", () => {
  it("first pass is a silent baseline: no question, no toast", async () => {
    const { catchUpDesktopAlerts } = await freshModule();
    serve({ held: false, summaryTitle: SUMMARY, items: [missed("n1", "Kim")] });
    await catchUpDesktopAlerts("u1", [mailRow("n1")]);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(banners()).toEqual([]);
  });

  it("two bells at once: the summary toasts exactly once", async () => {
    const { catchUpDesktopAlerts } = await freshModule();
    await catchUpDesktopAlerts("u2", []); // baseline
    serve({
      held: false,
      summaryTitle: SUMMARY,
      items: [missed("n1", "Kim"), missed("n2", "Lee")],
    });
    const rows = [mailRow("n1"), mailRow("n2")];
    await Promise.all([catchUpDesktopAlerts("u2", rows), catchUpDesktopAlerts("u2", rows)]);
    expect(banners()).toEqual([
      { title: "2 urgent emails while Klorn was closed", body: "Kim, Lee", open: "/today" },
    ]);
    // The next refetch asks nothing.
    apiFetch.mockClear();
    await catchUpDesktopAlerts("u2", rows);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("one missed mail: its own toast, opening it", async () => {
    const { catchUpDesktopAlerts } = await freshModule();
    await catchUpDesktopAlerts("u3", []);
    serve({ held: false, summaryTitle: SUMMARY, items: [missed("n1", "Kim")] });
    await catchUpDesktopAlerts("u3", [mailRow("n1")]);
    expect(banners()).toEqual([{ title: "Kim", body: "Subject", open: "/email/mail-n1" }]);
  });

  it("quiet hours: nothing shown, no question for 5 minutes, then the toast", async () => {
    const { catchUpDesktopAlerts } = await freshModule();
    await catchUpDesktopAlerts("u4", []);
    serve({ held: true, summaryTitle: SUMMARY, items: [] });
    const rows = [mailRow("n1")];
    await catchUpDesktopAlerts("u4", rows);
    expect(banners()).toEqual([]);
    apiFetch.mockClear();
    await catchUpDesktopAlerts("u4", rows);
    expect(apiFetch).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 5 * 60_000 + 1);
    serve({ held: false, summaryTitle: SUMMARY, items: [missed("n1", "Kim")] });
    await catchUpDesktopAlerts("u4", rows);
    expect(banners()).toEqual([{ title: "Kim", body: "Subject", open: "/email/mail-n1" }]);
  });

  it("a failed request records nothing, so the next pass asks again", async () => {
    const { catchUpDesktopAlerts } = await freshModule();
    await catchUpDesktopAlerts("u5", []);
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    await catchUpDesktopAlerts("u5", [mailRow("n1")]);
    expect(banners()).toEqual([]);
    serve({ held: false, summaryTitle: SUMMARY, items: [missed("n1", "Kim")] });
    await catchUpDesktopAlerts("u5", [mailRow("n1")]);
    expect(banners()).toHaveLength(1);
  });
});
