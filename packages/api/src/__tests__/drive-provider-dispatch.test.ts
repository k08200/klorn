/**
 * D2: the drive provider seam (drive/providers). v1 of an external connector
 * lists, searches and reads metadata; it never uploads or edits (decision V4),
 * and it does not fetch a file's bytes: that arrives with D4, with a streaming
 * size check. D2 ships no connector: every provider answers the explicit
 * "unsupported" result.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRIVE_PROVIDER_NAMES, type DriveProviderName } from "../drive/drive-providers.js";
import type { DriveProviderEnabledMap } from "../drive/drive-scope.js";
import { driveActionsForProvider } from "../drive/providers/dispatch.js";
import {
  type DriveProviderActions,
  type DriveProviderSession,
  isDriveUnsupported,
  type ProviderDriveFile,
} from "../drive/providers/types.js";
import { unsupportedDriveActions } from "../drive/providers/unsupported.js";

const SOURCE = { userId: "user-1", sourceKey: "acct-1" };
const on = () => true;
const ALL_ON: DriveProviderEnabledMap = { KLORN: on, GOOGLE: on, ONEDRIVE: on };

function fakeSession(provider: DriveProviderName): DriveProviderSession {
  return {
    provider,
    list: vi.fn(async () => ({ files: [], nextPageToken: null })),
    search: vi.fn(async () => ({ files: [], nextPageToken: null })),
    getMetadata: vi.fn(async () => null),
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
});

describe("a registered connector", () => {
  const session = fakeSession("GOOGLE");
  const real = fakeActions(session);
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

  it("connect answers the session, or null for a source that is not connected", async () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const actions = driveActionsForProvider("GOOGLE", { GOOGLE: on }, implementations);
    expect(await actions.connect(SOURCE)).toBe(session);
    const notConnected = driveActionsForProvider(
      "GOOGLE",
      { GOOGLE: on },
      { GOOGLE: fakeActions(null) },
    );
    expect(await notConnected.connect(SOURCE)).toBeNull();
  });
});

describe("the unsupported stub", () => {
  it("names its provider and nothing else", async () => {
    const stub = unsupportedDriveActions("ONEDRIVE");
    expect(stub.provider).toBe("ONEDRIVE");
    expect(await stub.connect(SOURCE)).toEqual({
      unsupported: true,
      error: "Drive provider ONEDRIVE is not supported from Klorn yet.",
    });
  });

  it("isDriveUnsupported tells the three results apart", () => {
    expect(isDriveUnsupported(null)).toBe(false);
    expect(isDriveUnsupported(fakeSession("GOOGLE"))).toBe(false);
    expect(isDriveUnsupported({ unsupported: true, error: "x" })).toBe(true);
  });
});

describe("what a provider reports about a file", () => {
  it("carries the source's own version, for change detection (D4, D5, D6)", () => {
    const file: ProviderDriveFile = {
      externalId: "file-1",
      name: "Q3 report.pdf",
      mimeType: "application/pdf",
      isFolder: false,
      sizeBytes: 2_048,
      parentExternalId: null,
      modifiedAt: new Date("2026-10-01T09:00:00.000Z"),
      webUrl: "https://drive.google.com/file/d/file-1/view",
      etag: "v7",
      trashed: false,
    };
    expect(file.etag).toBe("v7");
  });
});

describe("the seam reads metadata only", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "drive", "providers");
  const types = readFileSync(join(dir, "types.ts"), "utf8");
  const dispatch = readFileSync(join(dir, "dispatch.ts"), "utf8");
  const body = types.slice(types.indexOf("export interface DriveProviderSession {"));
  const session = body.slice(0, body.indexOf("\n}"));

  it("a session has exactly these three methods", () => {
    const methods = [...session.matchAll(/^ {2}(\w+)\(/gm)].map((match) => match[1]);
    expect(methods).toEqual(["list", "search", "getMetadata"]);
  });

  it("decision V4: no type of the seam names a write", () => {
    expect(types).not.toMatch(/\b(upload|create|update|delete|rename|move|write|trash)\w*\s*\(/i);
  });

  it("nothing fetches a file's bytes yet: D4 adds that, with its own size check", () => {
    for (const text of [types, dispatch]) {
      expect(text).not.toMatch(/fetchForSummary\s*\(|SUMMARY_MAX_BYTES|Uint8Array/);
    }
  });
});
