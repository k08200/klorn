/**
 * A test app for the Klorn drive (D3): the D2 read routes and the D3 routes over
 * a fake database (driveFile, storagePurge) and the in-memory object store,
 * with all three flags on. The test file mocks ../db.js with `klornDriveDbMock`
 * and ../sentry.js.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { vi } from "vitest";
import { MemoryObjectStore } from "../../storage/memory-store.js";
import { setObjectStoreForTests } from "../../storage/runtime.js";
import { createFakeDb, type FakeDb, fakePrismaClient, type Row } from "./fake-db.js";

export const PREFIX = "/api/drive";
export const FLAGS = ["DRIVE_ENABLED", "KLORN_DRIVE_ENABLED", "OBJECT_STORAGE_ENABLED"] as const;

export const holder: { db: FakeDb | null } = { db: null };

/** The body of `vi.mock("../db.js", ...)` for these tests. */
export function klornDriveDbMock(): { prisma: unknown; db: unknown } {
  const fake = fakePrismaClient(() => holder.db as FakeDb) as Record<string, unknown>;
  const prisma = {
    get driveFile() {
      return fake.driveFile;
    },
    get storagePurge() {
      return fake.storagePurge;
    },
    user: { findUnique: vi.fn(async () => ({ id: "user-1", plan: "PRO", role: "USER" })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "device-1" })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, db: prisma };
}

export interface KlornDriveTestApp {
  app: FastifyInstance;
  db: FakeDb;
  store: MemoryObjectStore;
  me: Record<string, string>;
  other: Record<string, string>;
}

let seq = 0;

/** A Klorn row of user-1 (override anything). */
export function klornRow(over: Row = {}): Row {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    id,
    userId: "user-1",
    provider: "KLORN",
    sourceKey: "klorn",
    externalId: `ext-${seq}`,
    name: `file ${seq}.pdf`,
    mimeType: "application/pdf",
    isFolder: false,
    sizeBytes: 3n,
    modifiedAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + seq * 60_000),
    storageKey: null,
    ...over,
  };
}

export function resetRowIds(): void {
  seq = 0;
}

/** A quota large enough for every test that is not about the quota (10 GiB). */
export const TEST_QUOTA_BYTES = String(10 * 1024 ** 3);

/** All three flags on, and a quota: the drive refuses uploads without one. */
export function flagsOn(): void {
  for (const name of FLAGS) vi.stubEnv(name, "true");
  vi.stubEnv("KLORN_DRIVE_QUOTA_BYTES", TEST_QUOTA_BYTES);
}

export async function buildKlornDriveApp(
  options: { seed?: Row[]; withRateLimit?: boolean } = {},
): Promise<KlornDriveTestApp> {
  const db = createFakeDb({ driveFile: options.seed ?? [], storagePurge: [] });
  holder.db = db;
  const store = new MemoryObjectStore();
  setObjectStoreForTests(store);
  // Imported here, not at the top: these reach ../db.js, whose mock imports this file.
  const { signToken } = await import("../../auth.js");
  const { driveRoutes } = await import("../../routes/drive.js");
  const { klornDriveRoutes, klornDriveRoutesEnabled } = await import("../../routes/klorn-drive.js");
  const { driveEnabled } = await import("../../config.js");
  const app = Fastify();
  if (options.withRateLimit) {
    await app.register(rateLimit, {
      max: 100_000,
      timeWindow: "1 minute",
      keyGenerator: (req) => {
        const cf = req.headers["cf-connecting-ip"];
        return typeof cf === "string" && cf.length > 0 ? cf : req.ip;
      },
    });
  }
  await app.register(driveRoutes({ gate: driveEnabled }), { prefix: PREFIX });
  await app.register(klornDriveRoutes({ gate: klornDriveRoutesEnabled }), { prefix: PREFIX });
  await app.ready();
  const bearer = (userId: string) => ({
    authorization: `Bearer ${signToken({ userId, email: `${userId}@example.com` })}`,
  });
  return { app, db, store, me: bearer("user-1"), other: bearer("user-2") };
}

export interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Uint8Array;
}

/** A multipart/form-data body, parts in the given order. */
export function multipart(parts: readonly MultipartPart[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----klorn-drive-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const file = part.filename === undefined ? "" : `; filename="${part.filename}"`;
    const type = part.contentType === undefined ? "" : `Content-Type: ${part.contentType}\r\n`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${file}\r\n${type}\r\n`,
        "utf8",
      ),
      Buffer.from(part.data ?? Buffer.from(part.value ?? "", "utf8")),
      Buffer.from("\r\n", "utf8"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** POST /files with a size field (the real length unless given), an optional parent, then the file. */
export async function upload(
  t: Pick<KlornDriveTestApp, "app">,
  headers: Record<string, string>,
  file: {
    filename: string;
    data: Uint8Array;
    contentType?: string;
    size?: string;
    parent?: string;
  },
): Promise<LightMyRequestResponse> {
  const parts: MultipartPart[] = [{ name: "size", value: file.size ?? String(file.data.length) }];
  if (file.parent !== undefined) parts.push({ name: "parentExternalId", value: file.parent });
  parts.push({
    name: "file",
    filename: file.filename,
    contentType: file.contentType ?? "application/octet-stream",
    data: file.data,
  });
  const body = multipart(parts);
  return await t.app.inject({
    method: "POST",
    url: `${PREFIX}/files`,
    headers: { ...headers, ...body.headers },
    payload: body.payload,
  });
}

export const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
