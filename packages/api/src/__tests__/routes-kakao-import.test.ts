/**
 * /api/kakao-import (docs/providers/kakaotalk-import.md §6): dark while
 * KAKAO_IMPORT_ENABLED is off (default 404, even unauthenticated),
 * cohort-gated, scoped to the session user, two steps (preview stores
 * nothing; import needs consent and a speaker from the file), and no error
 * echoes the uploaded text.
 */

import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: "user-a", authed: true }));
vi.mock("../auth.js", () => ({
  requireAuth: async (
    _request: unknown,
    reply: { code(n: number): { send(b: unknown): void } },
  ) => {
    if (!auth.authed) reply.code(401).send({ error: "Authentication required" });
  },
  getUserId: () => auth.userId,
}));

const store = vi.hoisted(() => ({
  createKakaoImport: vi.fn(),
  listKakaoImports: vi.fn(),
  getKakaoImport: vi.fn(),
  deleteKakaoImport: vi.fn(),
}));
vi.mock("../kakao-import/store.js", () => ({ ...store, KAKAO_MAX_IMPORTS_PER_USER: 20 }));
vi.mock("../user-timezone.js", () => ({ getUserTimeZone: vi.fn(async () => "Asia/Seoul") }));

import { KAKAO_MAX_FILE_BYTES } from "../kakao-import/parse.js";
import { kakaoImportRoutes } from "../routes/kakao-import.js";

const NOW = new Date("2026-11-15T03:00:00.000Z");
const FIXTURE = readFileSync(new URL("./fixtures/kakao/mobile-dotted-ko.txt", import.meta.url));
const ORIGINAL_ENV = { ...process.env };

interface Part {
  name: string;
  value?: string;
  filename?: string;
  data?: Uint8Array;
}

function multipart(parts: readonly Part[]) {
  const boundary = "----kakao-import-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const file = part.filename === undefined ? "" : `; filename="${part.filename}"`;
    const type = part.filename === undefined ? "" : "Content-Type: text/plain\r\n";
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${file}\r\n${type}\r\n`,
      ),
      Buffer.from(part.data ?? Buffer.from(part.value ?? "")),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const file = (data: Uint8Array = FIXTURE): Part => ({ name: "file", filename: "talk.txt", data });

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    status: "PENDING",
    format: "mobile-dotted",
    totalMessages: 7,
    windowMessages: 4,
    speakerCount: 3,
    windowStart: "2026-10-16T03:00:00.000Z",
    windowEnd: "2026-11-16T03:00:00.000Z",
    candidatesFound: 0,
    commitmentsCreated: 0,
    duplicatesSkipped: 0,
    errorCode: null,
    createdAt: NOW.toISOString(),
    processedAt: null,
    ...overrides,
  };
}

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(kakaoImportRoutes, { prefix: "/api/kakao-import" });
  await instance.ready();
  return instance;
}

function post(url: string, parts: readonly Part[]) {
  return app.inject({ method: "POST", url, ...multipart(parts) });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  auth.userId = "user-a";
  auth.authed = true;
  process.env.KAKAO_IMPORT_ENABLED = "on";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  store.createKakaoImport.mockResolvedValue({ ok: true, summary: summary() });
  store.listKakaoImports.mockResolvedValue([summary()]);
  store.getKakaoImport.mockResolvedValue(summary());
  store.deleteKakaoImport.mockResolvedValue(true);
  app = await build();
});

afterEach(async () => {
  await app.close();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("dark and cohort gates", () => {
  it("answers Fastify's default 404 for every route while the flag is off, even unauthenticated", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "off";
    auth.authed = false;
    const missing = await app.inject({ method: "GET", url: "/api/kakao-import/no-such-route/x/y" });
    for (const [method, url] of [
      ["POST", "/api/kakao-import/preview"],
      ["POST", "/api/kakao-import"],
      ["GET", "/api/kakao-import"],
      ["GET", "/api/kakao-import/abc"],
      ["DELETE", "/api/kakao-import/abc"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        ...missing.json(),
        message: `Route ${method}:${url} not found`,
      });
    }
  });

  it("answers 404 to a user outside the cohort", async () => {
    process.env.KAKAO_IMPORT_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    expect((await app.inject({ method: "GET", url: "/api/kakao-import" })).statusCode).toBe(404);
  });

  it("requires authentication once open", async () => {
    auth.authed = false;
    expect((await app.inject({ method: "GET", url: "/api/kakao-import" })).statusCode).toBe(401);
  });
});

describe("POST /preview", () => {
  it("returns the speakers and window counts and stores nothing", async () => {
    const res = await post("/api/kakao-import/preview", [file()]);
    expect(res.statusCode).toBe(200);
    const { preview } = res.json();
    expect(preview.format).toBe("mobile-dotted");
    expect(preview.totalMessages).toBe(7);
    expect(preview.windowMessages).toBe(4);
    expect(preview.speakers).toEqual([
      { name: "김지수", total: 4, inWindow: 2 },
      { name: "이민호", total: 2, inWindow: 1 },
      { name: "박서연", total: 1, inWindow: 1 },
    ]);
    expect(store.createKakaoImport).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown-format", 422, Buffer.from("15/01/2026, 09:05 - Alex: Hello\n")],
    ["zip-not-supported", 415, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14])],
    ["unsupported-encoding", 415, Buffer.from([0xbe, 0xc8, 0xb3, 0xe7])],
    ["empty-file", 400, Buffer.alloc(0)],
  ])("refuses %s with %i and a code, echoing nothing", async (code, status, data) => {
    const res = await post("/api/kakao-import/preview", [file(data)]);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: expect.any(String), code });
  });

  it("refuses a file over the cap with 413 file-too-large", async () => {
    const res = await post("/api/kakao-import/preview", [
      file(Buffer.alloc(KAKAO_MAX_FILE_BYTES + 1, 0x61)),
    ]);
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("file-too-large");
  });

  it("refuses a body that is not multipart", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/kakao-import/preview",
      payload: { file: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid-upload");
  });

  it("refuses an unexpected field, a second file, or no file", async () => {
    for (const parts of [
      [{ name: "extra", value: "1" }, file()],
      [file(), file()],
      [{ name: "consent", value: "true" }],
    ]) {
      const res = await post("/api/kakao-import/preview", parts);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid-upload");
    }
  });
});

describe("POST / (import)", () => {
  const consent: Part = { name: "consent", value: "true" };

  it("needs the consent that the file holds other people's messages", async () => {
    const res = await post("/api/kakao-import", [{ name: "me", value: "김지수" }, file()]);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("consent-required");
    expect(store.createKakaoImport).not.toHaveBeenCalled();
  });

  it("needs 'me' to be a speaker in the file", async () => {
    const res = await post("/api/kakao-import", [consent, { name: "me", value: "누군가" }, file()]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String), code: "speaker-not-found" });
    expect(JSON.stringify(res.json())).not.toContain("누군가");
  });

  it("stores the in-window text messages with the picked speaker and answers 201", async () => {
    const res = await post("/api/kakao-import", [consent, { name: "me", value: "이민호" }, file()]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ import: summary() });
    const [input] = store.createKakaoImport.mock.calls[0] as [Record<string, unknown>];
    expect(input).toMatchObject({
      userId: "user-a",
      format: "mobile-dotted",
      totalMessages: 7,
      speakerCount: 3,
      me: "이민호",
    });
    const messages = input.messages as Array<{ speaker: string; kind: string; sentAt: Date }>;
    expect(messages.map((m) => m.speaker)).toEqual(["김지수", "이민호", "김지수", "박서연"]);
    expect(messages.every((m) => m.kind === "text")).toBe(true);
    expect(messages[0].sentAt.toISOString()).toBe("2026-11-10T00:05:00.000Z");
  });

  it("answers 409 when the user already keeps the most imports", async () => {
    for (const reason of ["too-many-imports", "import-in-progress"]) {
      store.createKakaoImport.mockResolvedValue({ ok: false, reason });
      const res = await post("/api/kakao-import", [
        consent,
        { name: "me", value: "이민호" },
        file(),
      ]);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe(reason);
    }
  });
});

describe("upload slots", () => {
  it("refuses an upload with 503 busy while the slots are taken", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.createKakaoImport.mockImplementation(async () => {
      await held;
      return { ok: true, summary: summary() };
    });
    const parts = [{ name: "consent", value: "true" }, { name: "me", value: "이민호" }, file()];
    const first = post("/api/kakao-import", parts);
    const second = post("/api/kakao-import", parts);
    await vi.waitFor(() => expect(store.createKakaoImport).toHaveBeenCalledTimes(2));
    const third = await post("/api/kakao-import/preview", [file()]);
    expect(third.statusCode).toBe(503);
    expect(third.json().code).toBe("busy");
    release();
    expect((await first).statusCode).toBe(201);
    expect((await second).statusCode).toBe(201);
    expect((await post("/api/kakao-import/preview", [file()])).statusCode).toBe(200);
  });
});

describe("list, get, delete", () => {
  it("lists the session user's imports", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kakao-import" });
    expect(res.json()).toEqual({ imports: [summary()] });
    expect(store.listKakaoImports).toHaveBeenCalledWith("user-a");
  });

  it("gets one of the user's imports, and 404s another's", async () => {
    const id = summary().id;
    expect((await app.inject({ method: "GET", url: `/api/kakao-import/${id}` })).json()).toEqual({
      import: summary(),
    });
    expect(store.getKakaoImport).toHaveBeenCalledWith("user-a", id);
    store.getKakaoImport.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: `/api/kakao-import/${id}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not-found");
  });

  it("deletes one of the user's imports with 204, and 404s an unknown one", async () => {
    const id = summary().id;
    expect(
      (await app.inject({ method: "DELETE", url: `/api/kakao-import/${id}` })).statusCode,
    ).toBe(204);
    expect(store.deleteKakaoImport).toHaveBeenCalledWith("user-a", id);
    store.deleteKakaoImport.mockResolvedValue(false);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/kakao-import/${id}` })).statusCode,
    ).toBe(404);
  });

  it("refuses an id that cannot be an import id without a query", async () => {
    const res = await app.inject({ method: "GET", url: `/api/kakao-import/${"x".repeat(80)}` });
    expect(res.statusCode).toBe(404);
    expect(store.getKakaoImport).not.toHaveBeenCalled();
  });
});
