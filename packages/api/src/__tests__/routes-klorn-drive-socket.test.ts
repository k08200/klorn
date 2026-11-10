/**
 * D3: an upload refused part-way must still read the client's body to its end,
 * over a real socket. Otherwise the client's write never completes and the
 * connection is held until a server timeout (found in review; `inject` cannot
 * show it, because it never back-pressures).
 */

import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKlornDriveApp,
  flagsOn,
  type KlornDriveTestApp,
  multipart,
  PREFIX,
  resetRowIds,
} from "./helpers/klorn-drive-app.js";

vi.mock("../db.js", async () => {
  const { klornDriveDbMock } = await import("./helpers/klorn-drive-app.js");
  return klornDriveDbMock();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { setObjectStoreForTests } from "../storage/runtime.js";

/** Large enough that an unread body fills the socket buffers. */
const BODY_BYTES = 8 * 1024 * 1024;
const WRITE_DEADLINE_MS = 5_000;

let t: KlornDriveTestApp;

beforeEach(async () => {
  resetRowIds();
  flagsOn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  t = await buildKlornDriveApp();
  await t.app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  t.app.server.closeAllConnections();
  await t.app.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

/** Sends the body; answers the status and whether the whole body was written in time. */
async function send(fields: Array<{ name: string; value: string }>): Promise<{
  status: number;
  written: boolean;
}> {
  const body = multipart([
    ...fields,
    { name: "file", filename: "big.bin", data: new Uint8Array(BODY_BYTES).fill(7) },
  ]);
  const { port } = t.app.server.address() as AddressInfo;
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: `${PREFIX}/files`,
    headers: { ...t.me, ...body.headers, "content-length": String(body.payload.length) },
  });
  req.on("error", () => {});
  const response = once(req, "response");
  const finished = once(req, "finish").then(() => true);
  const deadline = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), WRITE_DEADLINE_MS),
  );
  req.end(body.payload);
  const [res] = (await response) as [{ statusCode: number; resume: () => void }];
  res.resume();
  const written = await Promise.race([finished, deadline]);
  return { status: res.statusCode, written };
}

describe("a refused upload still reads the client's body to its end", () => {
  it.each([
    ["a body longer than its declared size", [{ name: "size", value: "1" }], 400],
    ["an unknown field before the file", [{ name: "colour", value: "red" }], 400],
    ["a missing size", [], 400],
  ])("%s", async (_label, fields, status) => {
    const result = await send(fields);
    expect(result.status).toBe(status);
    expect(result.written).toBe(true);
    expect(t.store.keys()).toEqual([]);
  });
});
