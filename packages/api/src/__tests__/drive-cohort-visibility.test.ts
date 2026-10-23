/**
 * The rollout cohort (L23) reaches the drive's data, not only its routes: with
 * the drive on for everyone and one source in `cohort` mode, a user outside the
 * cohort sees none of that source's rows, whatever rows they hold (a cohort that
 * shrank, or a source taken back from everyone to the cohort).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKlornDriveApp,
  flagsOn,
  type KlornDriveTestApp,
  klornRow,
  PREFIX,
  resetRowIds,
} from "./helpers/klorn-drive-app.js";

vi.mock("../db.js", async () => {
  const { klornDriveDbMock } = await import("./helpers/klorn-drive-app.js");
  return klornDriveDbMock();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  DRIVE_PROVIDER_ENABLED,
  driveProvidersFor,
  filesVisibleFor,
} from "../drive/drive-scope.js";

let t: KlornDriveTestApp;

beforeEach(async () => {
  resetRowIds();
  flagsOn();
  vi.stubEnv("KLORN_DRIVE_ENABLED", "cohort");
  vi.stubEnv("ROLLOUT_COHORT_USER_IDS", "user-1");
  t = await buildKlornDriveApp({
    seed: [
      klornRow({ id: "00000000-0000-4000-8000-0000000000a1", userId: "user-1", name: "mine.txt" }),
      klornRow({
        id: "00000000-0000-4000-8000-0000000000b1",
        userId: "user-2",
        name: "theirs.txt",
      }),
    ],
  });
});

afterEach(async () => {
  await t.app.close();
  vi.unstubAllEnvs();
});

describe("a Klorn drive in cohort mode, the drive on for everyone", () => {
  it("lists a user's own Klorn files only inside the cohort", async () => {
    const mine = await t.app.inject({ method: "GET", url: `${PREFIX}/files`, headers: t.me });
    expect(mine.json().files.map((f: { name: string }) => f.name)).toEqual(["mine.txt"]);
    const theirs = await t.app.inject({ method: "GET", url: `${PREFIX}/files`, headers: t.other });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().files).toEqual([]);
  });

  it("hides a Klorn file by id from its owner outside the cohort", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `${PREFIX}/files/00000000-0000-4000-8000-0000000000b1`,
      headers: t.other,
    });
    expect(res.statusCode).toBe(404);
  });

  it("shows the Files tab only to the cohort", () => {
    expect(filesVisibleFor("user-1")).toBe(true);
    expect(filesVisibleFor("user-2")).toBe(false);
  });
});

describe("driveProvidersFor", () => {
  it("covers exactly the registered sources", () => {
    expect(Object.keys(driveProvidersFor("user-1")).sort()).toEqual(
      Object.keys(DRIVE_PROVIDER_ENABLED).sort(),
    );
  });
});
