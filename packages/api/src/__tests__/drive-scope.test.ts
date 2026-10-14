/**
 * D2: the drive kill switch (drive/drive-scope.ts). A DriveFile row is visible
 * only while DRIVE_ENABLED is on AND its provider's own connector flag is: every
 * list and search spreads `driveSourceScope()` into its `where`, every by-id read
 * checks `isDriveRowVisible`. It fails closed: a provider nobody registered is
 * hidden. D3 registers KLORN, live only with KLORN_DRIVE_ENABLED and
 * OBJECT_STORAGE_ENABLED on as well.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { driveEnabled } from "../config.js";
import {
  DRIVE_PROVIDER_ENABLED,
  type DriveProviderEnabledMap,
  driveSourceScope,
  isDriveRowVisible,
  klornDriveLive,
  klornDriveRoutesEnabled,
  visibleDriveProviders,
} from "../drive/drive-scope.js";

const on = () => true;
const off = () => false;
const ALL_ON: DriveProviderEnabledMap = { KLORN: on, GOOGLE: on, ONEDRIVE: on };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DRIVE_ENABLED", () => {
  it.each(["true", "1", "yes", "on", " TRUE "])("%j turns it on", (value) => {
    vi.stubEnv("DRIVE_ENABLED", value);
    expect(driveEnabled()).toBe(true);
  });

  it.each(["", "false", "0", "off", "enabled"])("%j leaves it off", (value) => {
    vi.stubEnv("DRIVE_ENABLED", value);
    expect(driveEnabled()).toBe(false);
  });

  it("is off when unset", () => {
    vi.stubEnv("DRIVE_ENABLED", undefined as unknown as string);
    expect(driveEnabled()).toBe(false);
  });
});

describe("the shipped registry", () => {
  const FLAGS = ["DRIVE_ENABLED", "KLORN_DRIVE_ENABLED", "OBJECT_STORAGE_ENABLED"] as const;
  function flags(on: readonly (typeof FLAGS)[number][]): void {
    for (const name of FLAGS) vi.stubEnv(name, on.includes(name) ? "true" : "false");
  }

  it("names only KLORN (D3); the external connectors are not registered yet", () => {
    expect(Object.keys(DRIVE_PROVIDER_ENABLED)).toEqual(["KLORN"]);
  });

  it("KLORN is visible only while the drive, the Klorn drive and object storage are all on", () => {
    flags(FLAGS);
    expect(visibleDriveProviders()).toEqual(["KLORN"]);
    expect(klornDriveLive()).toBe(true);
    expect(klornDriveRoutesEnabled()).toBe(true);
    expect(isDriveRowVisible({ provider: "KLORN" })).toBe(true);
    for (const provider of ["GOOGLE", "ONEDRIVE"]) {
      expect(isDriveRowVisible({ provider })).toBe(false);
    }
  });

  it.each(FLAGS)("turning %s off hides every Klorn file and darkens the Klorn routes", (name) => {
    flags(FLAGS.filter((flag) => flag !== name));
    expect(visibleDriveProviders()).toEqual([]);
    expect(driveSourceScope()).toEqual({ provider: { in: [] } });
    expect(isDriveRowVisible({ provider: "KLORN" })).toBe(false);
    expect(klornDriveRoutesEnabled()).toBe(false);
  });

  it("with every flag unset nothing is visible", () => {
    for (const name of FLAGS) vi.stubEnv(name, undefined as unknown as string);
    expect(visibleDriveProviders()).toEqual([]);
    expect(klornDriveRoutesEnabled()).toBe(false);
  });
});

describe("with DRIVE_ENABLED off", () => {
  it("nothing is visible, whatever a connector's own flag says", () => {
    vi.stubEnv("DRIVE_ENABLED", "false");
    expect(visibleDriveProviders(ALL_ON)).toEqual([]);
    expect(driveSourceScope(ALL_ON)).toEqual({ provider: { in: [] } });
    expect(isDriveRowVisible({ provider: "GOOGLE" }, ALL_ON)).toBe(false);
  });
});

describe("with DRIVE_ENABLED on", () => {
  it("a provider is visible only while its own flag is on", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const map: DriveProviderEnabledMap = { GOOGLE: on, ONEDRIVE: off };
    expect(visibleDriveProviders(map)).toEqual(["GOOGLE"]);
    expect(driveSourceScope(map)).toEqual({ provider: { in: ["GOOGLE"] } });
    expect(isDriveRowVisible({ provider: "GOOGLE" }, map)).toBe(true);
    expect(isDriveRowVisible({ provider: "ONEDRIVE" }, map)).toBe(false);
  });

  it("a provider nobody registered is hidden: the switch fails closed", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const map: DriveProviderEnabledMap = { GOOGLE: on };
    expect(isDriveRowVisible({ provider: "KLORN" }, map)).toBe(false);
    expect(isDriveRowVisible({ provider: "ONEDRIVE" }, map)).toBe(false);
    expect(visibleDriveProviders(map)).not.toContain("KLORN");
  });

  it("only a flag that answers exactly true counts", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    const map = { GOOGLE: () => "yes", ONEDRIVE: () => 1 } as unknown as DriveProviderEnabledMap;
    expect(visibleDriveProviders(map)).toEqual([]);
  });

  it("reads each flag at call time, so a flip needs no restart", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    let google = false;
    const map: DriveProviderEnabledMap = { GOOGLE: () => google };
    expect(visibleDriveProviders(map)).toEqual([]);
    google = true;
    expect(visibleDriveProviders(map)).toEqual(["GOOGLE"]);
    vi.stubEnv("DRIVE_ENABLED", "false");
    expect(visibleDriveProviders(map)).toEqual([]);
  });

  it("a provider string that is not a provider is never visible, prototype names included", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    for (const provider of ["constructor", "__proto__", "toString", "", "google", "DEVICE"]) {
      expect(isDriveRowVisible({ provider }, ALL_ON)).toBe(false);
    }
  });

  it("lists the visible providers in the enum's order, each once", () => {
    vi.stubEnv("DRIVE_ENABLED", "true");
    expect(visibleDriveProviders({ ONEDRIVE: on, KLORN: on })).toEqual(["KLORN", "ONEDRIVE"]);
    expect(visibleDriveProviders(ALL_ON)).toEqual(["KLORN", "GOOGLE", "ONEDRIVE"]);
  });
});
