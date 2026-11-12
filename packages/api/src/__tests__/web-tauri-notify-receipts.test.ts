/**
 * The Windows desktop shell's `shown` receipt
 * (packages/web/src/lib/native/tauri-notify.ts → desktop-receipts.ts): a toast
 * the shell posted reports `shown` for its bell row id, and hands that id to
 * `show_banner` so a click can report `clicked` (banner.rs). Nothing is
 * reported for a toast the shell did not post, nor for the catch-up summary,
 * which stands for several rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const tauriInvoke = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
const reportDesktopReceipt = vi.hoisted(() => vi.fn());

vi.mock("../../../web/src/lib/api", () => ({ apiFetch }));
vi.mock("../../../web/src/lib/sentry", () => ({ captureClientError: vi.fn() }));
vi.mock("../../../web/src/lib/native/shell", () => ({
  shellKind: () => "tauri",
  tauriInvoke,
}));
vi.mock("../../../web/src/lib/native/desktop-receipts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../web/src/lib/native/desktop-receipts")>()),
  reportDesktopReceipt,
}));

const NOW = Date.parse("2026-11-12T09:00:00.000Z");
const HOUR = 3_600_000;
const ROW = "0b9f6c1e-4a51-4d1e-9c4f-2f7d1f0a9b3c";
const ROW2 = "1c2d3e4f-0000-4000-8000-000000000002";
const SUMMARY = "{count} urgent emails while Klorn was closed";

function frame(id: string) {
  return {
    id,
    alert: "push",
    title: "Urgent email",
    message: "Kim: x",
    mail: { emailId: "mail-1", title: "Kim", body: "Subject" },
  };
}

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

async function freshModule() {
  vi.resetModules();
  return import("../../../web/src/lib/native/tauri-notify");
}

const banners = () => tauriInvoke.mock.calls.filter((c) => c[0] === "show_banner").map((c) => c[1]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  apiFetch.mockReset();
  tauriInvoke.mockReset();
  reportDesktopReceipt.mockReset();
});

describe("deliverDesktopAlert — the shown receipt", () => {
  it("a posted toast reports shown and carries its id for the click", async () => {
    tauriInvoke.mockResolvedValue(true);
    const { deliverDesktopAlert } = await freshModule();
    await deliverDesktopAlert("u1", frame(ROW));
    expect(banners()).toEqual([
      { title: "Kim", body: "Subject", open: "/email/mail-1", receipt: ROW },
    ]);
    expect(reportDesktopReceipt).toHaveBeenCalledExactlyOnceWith("shown", ROW);
  });

  it("a shell built before receipts (no answer) still counts as posted", async () => {
    tauriInvoke.mockResolvedValue(undefined);
    const { deliverDesktopAlert } = await freshModule();
    await deliverDesktopAlert("u1", frame(ROW));
    expect(reportDesktopReceipt).toHaveBeenCalledExactlyOnceWith("shown", ROW);
  });

  it("the shell did not post it (false): no receipt", async () => {
    tauriInvoke.mockResolvedValue(false);
    const { deliverDesktopAlert } = await freshModule();
    await deliverDesktopAlert("u1", frame(ROW));
    expect(banners()).toHaveLength(1);
    expect(reportDesktopReceipt).not.toHaveBeenCalled();
  });

  it("show_banner failed: no receipt", async () => {
    tauriInvoke.mockRejectedValue(new Error("ipc"));
    const { deliverDesktopAlert } = await freshModule();
    await deliverDesktopAlert("u1", frame(ROW));
    expect(reportDesktopReceipt).not.toHaveBeenCalled();
  });

  it("an id that is not a bell row uuid: the toast posts, nothing reports", async () => {
    tauriInvoke.mockResolvedValue(true);
    const { deliverDesktopAlert } = await freshModule();
    await deliverDesktopAlert("u1", frame("n1"));
    expect(banners()).toEqual([{ title: "Kim", body: "Subject", open: "/email/mail-1" }]);
    expect(reportDesktopReceipt).not.toHaveBeenCalled();
  });
});

describe("catchUpDesktopAlerts — receipts", () => {
  function serve(catchUp: unknown) {
    apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/notifications/desktop-catchup")) return catchUp;
      if (url === "/api/automations") return {};
      throw new Error(`unexpected ${url}`);
    });
  }

  it("one missed mail reports shown for its row", async () => {
    tauriInvoke.mockResolvedValue(true);
    const { catchUpDesktopAlerts } = await freshModule();
    await catchUpDesktopAlerts("u2", []); // baseline
    serve({ held: false, summaryTitle: SUMMARY, items: [missed(ROW, "Kim")] });
    await catchUpDesktopAlerts("u2", [mailRow(ROW)]);
    expect(reportDesktopReceipt).toHaveBeenCalledExactlyOnceWith("shown", ROW);
  });

  it("the summary of several stands for no single row: no receipt, no click id", async () => {
    tauriInvoke.mockResolvedValue(true);
    const { catchUpDesktopAlerts } = await freshModule();
    await catchUpDesktopAlerts("u3", []); // baseline
    serve({
      held: false,
      summaryTitle: SUMMARY,
      items: [missed(ROW, "Kim"), missed(ROW2, "Lee")],
    });
    await catchUpDesktopAlerts("u3", [mailRow(ROW), mailRow(ROW2)]);
    expect(banners()).toEqual([
      { title: "2 urgent emails while Klorn was closed", body: "Kim, Lee", open: "/today" },
    ]);
    expect(reportDesktopReceipt).not.toHaveBeenCalled();
  });
});
