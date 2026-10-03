/**
 * D2: the drive provider seam (drive/providers). v1 of an external connector
 * lists, searches, reads metadata and fetches a file for a summary under a size
 * cap; it never uploads or edits (decision V4). D2 ships no connector: every
 * provider answers the explicit "unsupported" result.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRIVE_PROVIDER_NAMES, type DriveProviderName } from "../drive/drive-providers.js";
import type { DriveProviderEnabledMap } from "../drive/drive-scope.js";
import {
  connectDriveSource,
  driveActionsForProvider,
  summaryByteCap,
  withSummaryCap,
} from "../drive/providers/dispatch.js";
import {
  DRIVE_SUMMARY_MAX_BYTES,
  type DriveProviderActions,
  type DriveProviderSession,
  type DriveSummaryResult,
  isDriveUnsupported,
} from "../drive/providers/types.js";
import { unsupportedDriveActions } from "../drive/providers/unsupported.js";
import { MAX_VISION_ATTACHMENT_BYTES } from "../mail/vision-attachment-policy.js";

const SOURCE = { userId: "user-1", sourceKey: "acct-1" };
const on = () => true;
const ALL_ON: DriveProviderEnabledMap = { KLORN: on, GOOGLE: on, ONEDRIVE: on, DEVICE: on };

function fakeSession(
  provider: DriveProviderName,
  fetchForSummary: DriveProviderSession["fetchForSummary"] = async () => ({ kind: "unavailable" }),
): DriveProviderSession {
  return {
    provider,
    list: vi.fn(async () => ({ files: [], nextPageToken: null })),
    search: vi.fn(async () => ({ files: [], nextPageToken: null })),
    getMetadata: vi.fn(async () => null),
    fetchForSummary,
  };
}

function fakeActions(session: DriveProviderSession | null): DriveProviderActions {
  return { provider: "GOOGLE", connect: vi.fn(async () => session) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the shipped dispatcher", () => {
  it.each([
    ...DRIVE_PROVIDER_NAMES,
  ])("%s answers unsupported, even with every flag on", async (provider) => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const actions = driveActionsForProvider(provider, ALL_ON);
    expect(actions.provider).toBe(provider);
    const result = await actions.connect(SOURCE);
    expect(isDriveUnsupported(result)).toBe(true);
    expect(result).toEqual({
      unsupported: true,
      error: `Drive provider ${provider} is not supported from Klorn yet.`,
    });
  });

  it("connectDriveSource hands the unsupported result on, never a session", async () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    for (const provider of DRIVE_PROVIDER_NAMES) {
      expect(isDriveUnsupported(await connectDriveSource(provider, SOURCE))).toBe(true);
    }
  });
});

describe("a registered connector", () => {
  const real = fakeActions(fakeSession("GOOGLE"));
  const implementations = { GOOGLE: real };

  it("serves its provider only while DRIVE_ENABLED and its own flag are on", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    expect(driveActionsForProvider("GOOGLE", { GOOGLE: on }, implementations)).toBe(real);
    expect(driveActionsForProvider("GOOGLE", { GOOGLE: () => false }, implementations)).not.toBe(
      real,
    );
    expect(driveActionsForProvider("GOOGLE", {}, implementations)).not.toBe(real);
    vi.stubEnv("DRIVE_ENABLED", "false");
    expect(driveActionsForProvider("GOOGLE", { GOOGLE: on }, implementations)).not.toBe(real);
  });

  it("is the unsupported stub while its flag is off, read per call", async () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const off = driveActionsForProvider("GOOGLE", { GOOGLE: () => false }, implementations);
    expect(isDriveUnsupported(await off.connect(SOURCE))).toBe(true);
  });

  it("never serves another provider", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    expect(driveActionsForProvider("ONEDRIVE", ALL_ON, implementations)).not.toBe(real);
  });

  it("connectDriveSource answers null for a source that is not connected", async () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const notConnected = { GOOGLE: fakeActions(null) };
    expect(await connectDriveSource("GOOGLE", SOURCE, { GOOGLE: on }, notConnected)).toBeNull();
  });

  it("connectDriveSource answers a session whose summary fetch is capped", async () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const seen: number[] = [];
    const session = fakeSession("GOOGLE", (_id, options) => {
      seen.push(options.maxBytes);
      return Promise.resolve({ kind: "unavailable" });
    });
    const connected = await connectDriveSource(
      "GOOGLE",
      SOURCE,
      { GOOGLE: on },
      {
        GOOGLE: fakeActions(session),
      },
    );
    if (connected === null || isDriveUnsupported(connected)) throw new Error("no session");
    await connected.fetchForSummary("file-1", { maxBytes: Number.MAX_SAFE_INTEGER });
    expect(seen).toEqual([DRIVE_SUMMARY_MAX_BYTES]);
  });
});

describe("the summary size cap", () => {
  it("is the attachment pipeline's, never more", () => {
    expect(DRIVE_SUMMARY_MAX_BYTES).toBe(8_000_000);
    expect(DRIVE_SUMMARY_MAX_BYTES).toBeLessThanOrEqual(MAX_VISION_ATTACHMENT_BYTES);
  });

  it("clamps what a caller asks for to the ceiling, and garbage to the ceiling too", () => {
    expect(summaryByteCap(1_000)).toBe(1_000);
    expect(summaryByteCap(1_000.9)).toBe(1_000);
    expect(summaryByteCap(DRIVE_SUMMARY_MAX_BYTES + 1)).toBe(DRIVE_SUMMARY_MAX_BYTES);
    for (const garbage of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(summaryByteCap(garbage)).toBe(DRIVE_SUMMARY_MAX_BYTES);
    }
  });

  it("a connector is asked for no more than the cap", async () => {
    const asked: number[] = [];
    const session = withSummaryCap(
      fakeSession("GOOGLE", (_id, options) => {
        asked.push(options.maxBytes);
        return Promise.resolve({ kind: "too-large", sizeBytes: null });
      }),
    );
    await session.fetchForSummary("f", { maxBytes: 50_000_000 });
    await session.fetchForSummary("f", { maxBytes: 4_096 });
    expect(asked).toEqual([DRIVE_SUMMARY_MAX_BYTES, 4_096]);
  });

  it("a connector that returns more than it was asked for is answered too-large: the bytes go no further", async () => {
    const oversized: DriveSummaryResult = {
      kind: "content",
      bytes: new Uint8Array(2_000),
      mimeType: "application/pdf",
    };
    const session = withSummaryCap(fakeSession("GOOGLE", async () => oversized));
    expect(await session.fetchForSummary("f", { maxBytes: 1_000 })).toEqual({
      kind: "too-large",
      sizeBytes: 2_000,
    });
  });

  it("content within the cap passes through unchanged", async () => {
    const content: DriveSummaryResult = {
      kind: "content",
      bytes: new Uint8Array(1_000),
      mimeType: "text/plain",
    };
    const session = withSummaryCap(fakeSession("GOOGLE", async () => content));
    expect(await session.fetchForSummary("f", { maxBytes: 1_000 })).toBe(content);
  });

  it("the other methods pass straight through", async () => {
    const inner = fakeSession("ONEDRIVE");
    const session = withSummaryCap(inner);
    expect(session.provider).toBe("ONEDRIVE");
    await session.list({ parentExternalId: null, pageSize: 10 });
    await session.search({ text: "q3", pageSize: 10 });
    await session.getMetadata("item-1");
    expect(inner.list).toHaveBeenCalledWith({ parentExternalId: null, pageSize: 10 });
    expect(inner.search).toHaveBeenCalledWith({ text: "q3", pageSize: 10 });
    expect(inner.getMetadata).toHaveBeenCalledWith("item-1");
  });
});

describe("the unsupported stub", () => {
  it("names its provider and nothing else", async () => {
    const stub = unsupportedDriveActions("DEVICE");
    expect(stub.provider).toBe("DEVICE");
    expect(await stub.connect(SOURCE)).toEqual({
      unsupported: true,
      error: "Drive provider DEVICE is not supported from Klorn yet.",
    });
  });

  it("isDriveUnsupported tells the three results apart", () => {
    expect(isDriveUnsupported(null)).toBe(false);
    expect(isDriveUnsupported(fakeSession("GOOGLE"))).toBe(false);
    expect(isDriveUnsupported({ unsupported: true, error: "x" })).toBe(true);
  });
});

describe("decision V4: the seam has no way to upload or edit", () => {
  const types = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "drive", "providers", "types.ts"),
    "utf8",
  );
  const body = types.slice(types.indexOf("export interface DriveProviderSession {"));
  const session = body.slice(0, body.indexOf("\n}"));

  it("a session has exactly these four methods", () => {
    const methods = [...session.matchAll(/^ {2}(\w+)\(/gm)].map((match) => match[1]);
    expect(methods).toEqual(["list", "search", "getMetadata", "fetchForSummary"]);
  });

  it("no type of the seam names a write", () => {
    expect(types).not.toMatch(/\b(upload|create|update|delete|rename|move|write|trash)\w*\s*\(/i);
  });
});
