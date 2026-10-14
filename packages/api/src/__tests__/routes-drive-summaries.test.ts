/**
 * D4: the summary surface of the drive routes. POST
 * /api/drive/files/:id/summarize (on demand, user-scoped, rate limited), the
 * summary on GET /api/drive/files/:id, the summary-text match in the `q` search,
 * and the queueing of a Klorn upload. All of it is dark while
 * DRIVE_SUMMARIES_ENABLED is off: the route answers exactly like an unregistered
 * one, the responses are D2's and D3's, and nothing reads the summary table.
 *
 * The model is a stub (drive-summary-failing-provider.test.ts runs the real LLM
 * layer); the app is the Klorn drive test app over a fake database and the
 * in-memory object store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKlornDriveApp,
  flagsOn,
  holder,
  type KlornDriveTestApp,
  PREFIX,
  upload,
} from "./helpers/klorn-drive-app.js";

const llm = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  result: null as unknown,
}));

vi.mock("../db.js", async () => {
  const { klornDriveDbMock } = await import("./helpers/klorn-drive-app.js");
  return klornDriveDbMock();
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../drive/summary-llm.js", () => ({
  summariseDriveText: vi.fn(async (input: Record<string, unknown>) => {
    llm.calls.push(input);
    return llm.result;
  }),
}));

const TEXT = "Kickoff agenda: hire two designers, budget 40k, launch 2026-11-02.";
const SUMMARY = "Kickoff agenda with a hiring plan and a 40k budget.";

let t: KlornDriveTestApp;

async function uploadText(name = "agenda.txt", text = TEXT, headers = t.me) {
  const res = await upload(t, headers, {
    filename: name,
    data: Buffer.from(text, "utf8"),
    contentType: "text/plain",
  });
  expect(res.statusCode).toBe(201);
  return res.json().file as { id: string; name: string };
}

const summarize = (id: string, headers: Record<string, string> = t.me) =>
  t.app.inject({ method: "POST", url: `${PREFIX}/files/${id}/summarize`, headers });
const getFile = (id: string, headers: Record<string, string> = t.me) =>
  t.app.inject({ method: "GET", url: `${PREFIX}/files/${id}`, headers });
const search = (q: string) =>
  t.app.inject({ method: "GET", url: `${PREFIX}/files?q=${encodeURIComponent(q)}`, headers: t.me });

beforeEach(async () => {
  flagsOn();
  llm.calls.length = 0;
  llm.result = { ok: true, summary: SUMMARY, model: "google/gemini-2.5-flash", costMicroCents: 42 };
});

afterEach(async () => {
  await t?.app.close();
  vi.unstubAllEnvs();
});

describe("while DRIVE_SUMMARIES_ENABLED is off", () => {
  beforeEach(async () => {
    t = await buildKlornDriveApp();
  });

  it("the summarize route answers exactly like an unregistered route, before authentication", async () => {
    const file = await uploadText();
    const dark = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files/${file.id}/summarize`,
    });
    const unregistered = await t.app.inject({
      method: "POST",
      url: `${PREFIX}/files/${file.id}/summarize`.replace("summarize", "no-such-route"),
    });
    expect(dark.statusCode).toBe(404);
    expect(dark.json()).toEqual({
      ...unregistered.json(),
      message: `Route POST:${PREFIX}/files/${file.id}/summarize not found`,
    });
    expect(llm.calls).toEqual([]);
  });

  it("an upload queues nothing, the file response has no summary, the search reads names only", async () => {
    const file = await uploadText();
    expect(holder.db?.tables.driveFileSummary).toEqual([]);
    holder.db?.reads.splice(0);
    const res = await getFile(file.id);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["file"]);
    expect((await search("hiring")).json().files).toEqual([]);
    expect(holder.db?.reads).not.toContain("driveFileSummary");
  });

  it("DRIVE_ENABLED off darkens everything, whatever the summaries flag says", async () => {
    vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "true");
    vi.stubEnv("DRIVE_ENABLED", "");
    const res = await summarize("00000000-0000-4000-8000-000000000001");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not Found");
  });
});

describe("while DRIVE_SUMMARIES_ENABLED is on", () => {
  beforeEach(async () => {
    vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "true");
    t = await buildKlornDriveApp();
  });

  it("an upload queues the file PENDING at its version; the upload response is unchanged", async () => {
    const file = await uploadText();
    const row = holder.db?.tables.driveFile.find((r) => r.id === file.id);
    expect(holder.db?.tables.driveFileSummary).toEqual([
      expect.objectContaining({
        driveFileId: file.id,
        userId: "user-1",
        status: "PENDING",
        sourceEtag: row?.etag,
      }),
    ]);
    expect(Object.keys(file).sort()).not.toContain("summary");
    expect(llm.calls).toEqual([]);
  });

  it("summarize runs it now, in the foreground, and answers the summary", async () => {
    const file = await uploadText();
    const res = await summarize(file.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      summary: {
        status: "DONE",
        text: SUMMARY,
        error: null,
        summarizedAt: expect.any(String),
      },
    });
    expect(llm.calls).toEqual([
      expect.objectContaining({ userId: "user-1", text: TEXT, priority: "foreground" }),
    ]);
    // Done at this version: asking again costs nothing.
    expect((await summarize(file.id)).json().summary.status).toBe("DONE");
    expect(llm.calls).toHaveLength(1);
  });

  it("is user-scoped: another user's file, an unknown id and a malformed id are one 404", async () => {
    const mine = await uploadText();
    for (const id of [mine.id, "00000000-0000-4000-8000-0000000000ff", "x".repeat(65)]) {
      const res = await summarize(id, t.other);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "File not found" });
    }
    expect(llm.calls).toEqual([]);
    expect(
      (await t.app.inject({ method: "POST", url: `${PREFIX}/files/${mine.id}/summarize` }))
        .statusCode,
    ).toBe(401);
  });

  it("the file response carries the summary; no response carries the text or a storage key", async () => {
    const file = await uploadText();
    await summarize(file.id);
    const res = await getFile(file.id);
    expect(res.json().summary).toMatchObject({ status: "DONE", text: SUMMARY });
    const storageKey = String(
      holder.db?.tables.driveFile.find((r) => r.id === file.id)?.storageKey,
    );
    for (const body of [res.body, (await summarize(file.id)).body, (await search("hiring")).body]) {
      expect(body).not.toContain(storageKey);
      expect(body).not.toContain("storageKey");
      expect(body).not.toContain("Kickoff agenda: hire");
    }
  });

  it("the search also matches summary text, escaped and scoped to the user", async () => {
    const agenda = await uploadText("agenda.txt");
    await uploadText("other.txt", "unrelated");
    await summarize(agenda.id);
    expect((await search("HIRING PLAN")).json().files.map((f: { id: string }) => f.id)).toEqual([
      agenda.id,
    ]);
    expect((await search("40%")).json().files).toEqual([]);
    expect((await search("hiring_plan")).json().files).toEqual([]);
    const theirs = await t.app.inject({
      method: "GET",
      url: `${PREFIX}/files?q=hiring`,
      headers: t.other,
    });
    expect(theirs.json().files).toEqual([]);
  });

  it("a failing model never breaks an upload or a listing: the summary waits with a code", async () => {
    llm.result = { ok: false, code: "llm-unavailable" };
    const file = await uploadText();
    const res = await summarize(file.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({
      status: "PENDING",
      text: null,
      error: "llm-unavailable",
      summarizedAt: null,
    });
    const list = await t.app.inject({ method: "GET", url: `${PREFIX}/files`, headers: t.me });
    expect(list.statusCode).toBe(200);
    expect(list.json().files.map((f: { id: string }) => f.id)).toEqual([file.id]);
    await uploadText("second.txt");
  });

  it("a queue failure never fails the upload", async () => {
    const summaries = holder.db?.model("driveFileSummary");
    if (!summaries) throw new Error("no db");
    vi.spyOn(summaries, "upsert").mockRejectedValueOnce(new Error("database is down"));
    const file = await uploadText();
    expect(file.id).toEqual(expect.any(String));
  });
});

describe("rate limit", () => {
  it("allows 10 summarize requests a minute per user, then 429", async () => {
    vi.stubEnv("DRIVE_SUMMARIES_ENABLED", "true");
    t = await buildKlornDriveApp({ withRateLimit: true });
    const file = await uploadText();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await summarize(file.id)).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(codes[10]).toBe(429);
  });
});
