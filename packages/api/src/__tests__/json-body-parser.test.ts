import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { handleError } = await import("../error-handler.js");
const { captureError } = await import("../sentry.js");
const { InvalidJsonBodyError, registerJsonBodyParser } = await import("../json-body-parser.js");
const { callText, LLM_CANARY } = await import("./helpers/canary.js");

// The real parser and the real global error handler, wired the way index.ts
// wires them. index.ts itself cannot be imported (it boots the server), so the
// last describe pins that it makes this same registration.

const PINO_WARN = 40;

type Wired = Awaited<ReturnType<typeof buildApp>>;

const openApps: Array<{ close: () => Promise<undefined> }> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function buildApp(options: { bodyLimit?: number } = {}) {
  const lines: string[] = [];
  const reached = vi.fn();
  const app = Fastify({
    ...options,
    logger: { level: "info", stream: { write: (l: string) => lines.push(l) } },
  });
  app.setErrorHandler(handleError);
  registerJsonBodyParser(app);
  app.post("/echo", async (request) => {
    reached();
    return {
      body: request.body ?? null,
      rawBody: (request as unknown as { rawBody?: string }).rawBody ?? null,
    };
  });
  await app.ready();
  openApps.push(app);
  return { app, lines, reached };
}

/** Pino lines at warn or above: a 4xx answered by the handler writes none. */
function loudLines(lines: string[]): string[] {
  return lines.filter((l) => (JSON.parse(l) as { level: number }).level >= PINO_WARN);
}

function expectQuiet({ lines }: Wired) {
  expect(captureError).not.toHaveBeenCalled();
  expect(loudLines(lines)).toEqual([]);
}

const JSON_HEADER = { "content-type": "application/json" };

describe("a malformed JSON body is the caller's mistake: 400, not 500", () => {
  it.each([
    ["an unterminated object", "{bad"],
    ["a truncated value", '{"a":'],
    ["plain text", "not json"],
    ["a trailing comma", '{"a":1,}'],
    ["a lone brace", "}"],
  ])("answers 400 with a fixed message for %s", async (_label, payload) => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp();
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid JSON body" });
    expect(wired.reached).not.toHaveBeenCalled();
    expectQuiet(wired);
  });

  it("never quotes the body: not in the response, the log or Sentry", async () => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp();
    // V8's SyntaxError message quotes the start of the input.
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload: `${LLM_CANARY} Re: the board numbers, not json`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(LLM_CANARY);
    expect(wired.lines.join("\n")).not.toContain(LLM_CANARY);
    expect(callText(vi.mocked(captureError))).not.toContain(LLM_CANARY);
    expectQuiet(wired);
  });

  it("carries the status and code of Fastify's own error for the same failure", () => {
    const own = new Fastify.errorCodes.FST_ERR_CTP_INVALID_JSON_BODY();
    const err = new InvalidJsonBodyError();
    expect(err).toMatchObject({ statusCode: own.statusCode, code: own.code });
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("Invalid JSON body");
    expect(err.cause).toBeUndefined();
  });

  it("answers the same 400 when the charset parameter is present", async () => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp();
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json; charset=utf-8" },
      payload: "{bad",
    });
    expect(res.statusCode).toBe(400);
    expectQuiet(wired);
  });
});

// Fastify's own parser refuses these (secure-json-parse, protoAction and
// constructorAction "error"); replacing it must not drop that. JSON.parse makes
// `__proto__` an own key, which Object.assign or a deep merge downstream then
// writes into a prototype.
describe("a prototype-poisoning key is refused like Fastify's own parser refuses it", () => {
  it.each([
    ["a top-level __proto__", '{"__proto__":{"isAdmin":true}}'],
    ["a nested __proto__", '{"a":{"b":{"__proto__":{"isAdmin":true}}}}'],
    ["a __proto__ inside an array", '{"items":[{"__proto__":{"isAdmin":true}}]}'],
    ["a unicode-escaped __proto__", '{"\\u005f_proto__":{"isAdmin":true}}'],
    ["constructor.prototype", '{"constructor":{"prototype":{"isAdmin":true}}}'],
    ["a nested constructor.prototype", '{"a":{"constructor":{"prototype":{"x":1}}}}'],
  ])("answers the same 400 for %s, before the handler runs", async (_label, payload) => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp();
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid JSON body" });
    expect(wired.reached).not.toHaveBeenCalled();
    expectQuiet(wired);
  });

  it("refuses with the same fixed error, no cause", async () => {
    const app = Fastify();
    registerJsonBodyParser(app);
    let seen: unknown;
    app.setErrorHandler((err, _request, reply) => {
      seen = err;
      reply.code(400).send({});
    });
    app.post("/echo", async () => ({}));
    await app.ready();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload: '{"__proto__":{"isAdmin":true}}',
    });
    expect(seen).toBeInstanceOf(InvalidJsonBodyError);
    expect((seen as Error).cause).toBeUndefined();
  });

  it("still accepts keys that only look alike", async () => {
    const wired = await buildApp();
    // A string constructor and a "proto" key are ordinary data; Fastify's
    // parser lets them through too.
    const payload = '{"constructor":"Acme Inc.","proto":1,"__proto":2,"prototype":{"a":1}}';
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      body: { constructor: "Acme Inc.", proto: 1, __proto: 2, prototype: { a: 1 } },
      rawBody: payload,
    });
  });
});

describe("a valid JSON body is parsed as before and keeps its raw bytes", () => {
  it("parses the body and sets rawBody to the exact bytes sent", async () => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp();
    // Odd spacing and key order: a signature is over these bytes, not over a
    // re-serialization of the parsed value.
    const payload = ' {"b": 2,  "a": [1, 2], "c": "é"}\n';
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { b: 2, a: [1, 2], c: "é" }, rawBody: payload });
    expectQuiet(wired);
  });

  it("accepts a leading byte-order mark, as Fastify's own parser does, and keeps it in rawBody", async () => {
    const wired = await buildApp();
    const payload = '\uFEFF{"a":1}';
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { a: 1 }, rawBody: payload });
  });

  it("treats an empty body under a JSON content-type as {}", async () => {
    const wired = await buildApp();
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload: "",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: {}, rawBody: "{}" });
  });

  it("does not run the parser for a request with no body and no content-type", async () => {
    const wired = await buildApp();
    const res = await wired.app.inject({ method: "POST", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null, rawBody: null });
  });

  it("accepts a charset parameter", async () => {
    const wired = await buildApp();
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json; charset=utf-8" },
      payload: '{"ok":true}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { ok: true }, rawBody: '{"ok":true}' });
  });
});

// Fastify raises these before our parser runs. They are pinned here because the
// same handler turns them into the response: a status below 500 must stay a
// quiet 4xx, never a 500 and a Sentry event.
describe("Fastify's own body errors stay quiet 4xx", () => {
  it("answers 413 when Content-Length is over the limit", async () => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp({ bodyLimit: 32 });
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload: JSON.stringify({ filler: "x".repeat(200) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "Request body is too large" });
    expect(wired.reached).not.toHaveBeenCalled();
    expectQuiet(wired);
  });

  it("answers 413 for a chunked body that grows past the limit", async () => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp({ bodyLimit: 32 });
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: JSON_HEADER,
      payload: Readable.from(['{"filler":"', "x".repeat(200), '"}']),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "Request body is too large" });
    expectQuiet(wired);
  });

  it("answers 415 for a content type with no parser", async () => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp();
    const res = await wired.app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/xml" },
      payload: "<a>hello</a>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: "Unsupported Media Type" });
    expect(wired.reached).not.toHaveBeenCalled();
    expectQuiet(wired);
  });

  it("answers 415 for a body sent with no content type at all", async () => {
    vi.mocked(captureError).mockClear();
    const wired = await buildApp();
    const res = await wired.app.inject({ method: "POST", url: "/echo", payload: '{"a":1}' });
    expect(res.statusCode).toBe(415);
    expectQuiet(wired);
  });
});

describe("index.ts uses this parser", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

  it("registers it on the app", () => {
    expect(source).toMatch(/^registerJsonBodyParser\(app\);$/m);
  });

  it("registers it before the routes, so every route's scope inherits it", () => {
    const parser = source.indexOf("registerJsonBodyParser(app);");
    const routes = source.indexOf("await registerApiRoutes(app);");
    expect(parser).toBeGreaterThan(-1);
    expect(routes).toBeGreaterThan(parser);
  });

  it("does not register a JSON parser of its own beside it", () => {
    expect(source).not.toContain("addContentTypeParser");
  });
});
