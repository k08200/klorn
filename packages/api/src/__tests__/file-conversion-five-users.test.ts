import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({
  requireAuth: async () => {},
  getUserId: (request: { headers: Record<string, string | string[] | undefined> }) => {
    const header = request.headers["x-test-user-id"];
    return Array.isArray(header) ? header[0] : header || "missing-user";
  },
}));

async function buildApp() {
  const { fileRoutes } = await import("../routes/files.js");
  const app = Fastify();
  await app.register(fileRoutes, { prefix: "/api/files" });
  return app;
}

function contentBase64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

describe("file conversion with five users", () => {
  const previousDir = process.env.EVE_CONVERSION_STORAGE_DIR;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "eve-five-user-conversion-"));
    process.env.EVE_CONVERSION_STORAGE_DIR = tempDir;
  });

  afterEach(async () => {
    if (previousDir === undefined) delete process.env.EVE_CONVERSION_STORAGE_DIR;
    else process.env.EVE_CONVERSION_STORAGE_DIR = previousDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lets five users convert, persist, list, and download only their own results", async () => {
    const app = await buildApp();
    const users = Array.from({ length: 5 }, (_, index) => `user-${index + 1}`);

    const conversions = await Promise.all(
      users.map(async (userId, index) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/files/convert",
          headers: { "x-test-user-id": userId },
          payload: {
            filename: `profile-${index + 1}.txt`,
            mimeType: "text/plain",
            contentBase64: contentBase64(
              `지원자 ${index + 1}\n역할: 배우\n연락처: 010-0000-000${index}`,
            ),
            targetFormat: "json",
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("application/json");
        const resultId = String(res.headers["x-jigeum-conversion-id"]);
        expect(resultId).toMatch(/^[0-9a-f-]{20,80}$/i);
        return { userId, resultId, body: res.body };
      }),
    );

    for (const conversion of conversions) {
      const listRes = await app.inject({
        method: "GET",
        url: "/api/files/results",
        headers: { "x-test-user-id": conversion.userId },
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json() as { results: Array<{ id: string; filename: string }> };
      expect(listBody.results.map((item) => item.id)).toEqual([conversion.resultId]);

      const downloadRes = await app.inject({
        method: "GET",
        url: `/api/files/results/${conversion.resultId}/download`,
        headers: { "x-test-user-id": conversion.userId },
      });
      expect(downloadRes.statusCode).toBe(200);
      expect(downloadRes.body).toBe(conversion.body);
    }

    const blockedRes = await app.inject({
      method: "GET",
      url: `/api/files/results/${conversions[0].resultId}/download`,
      headers: { "x-test-user-id": users[1] },
    });
    expect(blockedRes.statusCode).toBe(404);

    await app.close();
  });

  it("exposes engine status and a runnable quality suite", async () => {
    const app = await buildApp();
    const previous = process.env.EVE_DISABLE_CONVERTER_AUTODETECT;
    process.env.EVE_DISABLE_CONVERTER_AUTODETECT = "1";

    const conversionsRes = await app.inject({
      method: "GET",
      url: "/api/files/conversions",
      headers: { "x-test-user-id": "user-1" },
    });
    expect(conversionsRes.statusCode).toBe(200);
    expect(conversionsRes.json()).toMatchObject({
      targets: expect.arrayContaining(["pdf", "docx", "dwg", "dxf"]),
      engines: expect.arrayContaining([
        expect.objectContaining({ id: "office-layout" }),
        expect.objectContaining({ id: "cad-dwg" }),
      ]),
    });

    try {
      const qualityRes = await app.inject({
        method: "POST",
        url: "/api/files/quality-tests/run",
        headers: { "x-test-user-id": "user-1" },
      });
      expect(qualityRes.statusCode).toBe(200);
      expect(qualityRes.json()).toMatchObject({
        scenarios: expect.arrayContaining([expect.objectContaining({ id: "builtin-json" })]),
      });
    } finally {
      if (previous === undefined) delete process.env.EVE_DISABLE_CONVERTER_AUTODETECT;
      else process.env.EVE_DISABLE_CONVERTER_AUTODETECT = previous;
    }

    await app.close();
  });
});
