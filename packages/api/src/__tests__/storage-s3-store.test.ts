/**
 * The S3-compatible ObjectStore (step D1) over real HTTP against a local
 * stand-in that verifies every signature with an independent SigV4
 * implementation. No real bucket is involved; see
 * storage-s3-real-bucket.test.ts for that run.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StorageError } from "../storage/errors.js";
import { newObjectKey, userPrefix } from "../storage/keys.js";
import {
  S3_DELETE_CONCURRENCY,
  S3_MAX_ERROR_BODY_BYTES,
  S3_MAX_LIST_BODY_BYTES,
  S3ObjectStore,
  type S3StoreConfig,
} from "../storage/s3-store.js";
import { parseListObjectsXml, s3ErrorCodeOf } from "../storage/s3-xml.js";
import { FakeS3Server } from "./helpers/fake-s3-server.js";
import { describeObjectStoreContract } from "./helpers/object-store-contract.js";
import { referenceSignature } from "./helpers/sigv4-reference.js";
import { bytesOf, chunksOf, codeOfAsync, streamOf } from "./helpers/storage-bytes.js";

const SECRET = "fake-secret-never-logged-0123456789abcdef";
const ACCESS_KEY = "FAKEACCESSKEYID0001";
const BASE = { bucket: "klorn-test", region: "auto", accessKeyId: ACCESS_KEY } as const;

const server = new FakeS3Server({ ...BASE, secretAccessKey: SECRET });
let endpoint = "";

beforeAll(async () => {
  endpoint = await server.start();
});
afterAll(async () => {
  await server.stop();
});
afterEach(() => {
  server.listOverride = null;
  server.ignoreResponseOverrides = false;
  server.commitThenFail = null;
  server.requests.length = 0;
  vi.restoreAllMocks();
});

const requestsOf = (method: string) =>
  server.requests.filter((request) => request.method === method);

/** A response body that never ends: one 64 KiB chunk per pull, counted. */
function endlessBody(): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 65_536;
      controller.enqueue(new Uint8Array(65_536).fill(0x20));
    },
  });
  return { body, pulled: () => pulled };
}

function fetchAnswering(body: ReadableStream<Uint8Array>, status: number): typeof fetch {
  return (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;
}

function configFor(overrides: Partial<S3StoreConfig> = {}): S3StoreConfig {
  return { ...BASE, secretAccessKey: SECRET, endpoint, forcePathStyle: true, ...overrides };
}

async function errorOf(run: () => Promise<unknown>): Promise<StorageError> {
  const err = await run().then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(err instanceof StorageError)) throw new Error(`expected a StorageError, got ${err}`);
  return err;
}

describeObjectStoreContract("S3 implementation over a local stand-in", {
  makeStore: (limits) => new S3ObjectStore(configFor(), limits),
  fetchesSignedUrls: true,
});

describe("S3ObjectStore on the wire", () => {
  it("uploads with a Content-Length, never chunked, as an unsigned payload", async () => {
    const store = new S3ObjectStore(configFor());
    const key = newObjectKey("wire-user", "drive");
    await store.putObject(key, streamOf(bytesOf("abc"), bytesOf("de")), {
      contentType: "Application/PDF; x=1",
      size: 5,
    });
    const put = server.requests.find((request) => request.method === "PUT");
    expect(put?.path).toBe(`/klorn-test/${key}`);
    expect(put?.headers["content-length"]).toBe("5");
    expect(put?.headers["transfer-encoding"]).toBeUndefined();
    expect(put?.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(server.objects.get(key)?.bytes.toString("utf8")).toBe("abcde");
  });

  it("stores every object as an octet-stream attachment, the caller's type as metadata", async () => {
    const store = new S3ObjectStore(configFor());
    const key = newObjectKey("wire-user", "drive");
    await store.putObject(key, bytesOf("<h1>x</h1>"), { contentType: "Text/HTML; x=1", size: 10 });
    const put = requestsOf("PUT")[0];
    expect(put?.headers["content-type"]).toBe("application/octet-stream");
    expect(put?.headers["content-disposition"]).toBe("attachment");
    expect(put?.headers["x-amz-meta-content-type"]).toBe("text/html");
    // What the bucket holds is what protects a download, whatever the URL says.
    expect(server.objects.get(key)).toMatchObject({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
    });
    expect((await store.headObject(key))?.contentType).toBe("text/html");
    expect((await store.getObject(key))?.contentType).toBe("text/html");
  });

  it("still downloads, never renders, on a vendor that ignores the signed overrides", async () => {
    const store = new S3ObjectStore(configFor());
    const key = newObjectKey("wire-user", "drive");
    await store.putObject(key, bytesOf("<h1>x</h1>"), { contentType: "text/html", size: 10 });
    const signed = await store.signedDownloadUrl(key, {
      expiresInSeconds: 60,
      downloadName: "page.html",
    });
    server.ignoreResponseOverrides = true;
    const response = await fetch(signed.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });

  it("never completes a PUT whose stream goes on after its declared size", async () => {
    const store = new S3ObjectStore(configFor());
    const key = newObjectKey("wire-user", "drive");
    const put = () => store.putObject(key, chunksOf([10, 1]), { contentType: "a/b", size: 10 });
    expect(await codeOfAsync(put)).toBe("size-mismatch");
    // The chunk that would have completed the body was never sent.
    expect(requestsOf("PUT").every((request) => !request.completed)).toBe(true);
    expect(server.objects.has(key)).toBe(false);
  });

  it("removes the object when the bucket committed it but the upload still failed", async () => {
    const store = new S3ObjectStore(configFor());
    const key = newObjectKey("wire-user", "drive");
    server.commitThenFail = { status: 500, code: "InternalError" };
    const put = () => store.putObject(key, bytesOf("hello"), { contentType: "a/b", size: 5 });
    const err = await errorOf(put);
    expect(err.code).toBe("upstream");
    expect(server.requests.map((request) => request.method)).toEqual(["PUT", "DELETE"]);
    expect(server.objects.has(key)).toBe(false);
  });

  it("reports the upload's own failure when the clean-up delete fails too", async () => {
    const store = new S3ObjectStore(configFor());
    const key = newObjectKey("wire-user", "drive");
    server.commitThenFail = { status: 503, code: "SlowDown" };
    server.failNext("DELETE", 500, "InternalError");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const put = () => store.putObject(key, bytesOf("hello"), { contentType: "a/b", size: 5 });
    const err = await errorOf(put);
    expect(err.upstreamCode).toBe("SlowDown");
    // The leftover is said out loud: it is an object nobody has a record of.
    expect(warn).toHaveBeenCalledTimes(1);
    server.objects.delete(key);
  });

  it("never completes a PUT whose stream runs past the cap", async () => {
    const store = new S3ObjectStore(configFor(), { maxObjectBytes: 64 });
    const key = newObjectKey("wire-user", "drive");
    const put = () => store.putObject(key, chunksOf([40, 40]), { contentType: "a/b", size: 64 });
    expect(await codeOfAsync(put)).toBe("object-too-large");
    await vi.waitFor(() => {
      expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    });
    expect(server.requests.find((request) => request.method === "PUT")?.completed).toBe(false);
    expect(server.objects.has(key)).toBe(false);
  });

  it("sends nothing at all for a declared size over the cap", async () => {
    const store = new S3ObjectStore(configFor(), { maxObjectBytes: 64 });
    const key = newObjectKey("wire-user", "drive");
    const put = () => store.putObject(key, chunksOf([65]), { contentType: "a/b", size: 65 });
    expect(await codeOfAsync(put)).toBe("object-too-large");
    expect(server.requests).toHaveLength(0);
  });

  it("round-trips bytes that are not text", async () => {
    const store = new S3ObjectStore(configFor());
    const key = newObjectKey("wire-user", "attachment");
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    await store.putObject(key, bytes, { contentType: "application/octet-stream", size: 256 });
    const got = await store.getObject(key);
    const parts: Uint8Array[] = [];
    for await (const chunk of got?.body ?? []) parts.push(chunk as Uint8Array);
    expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("S3ObjectStore addressing", () => {
  const NOW = new Date("2026-10-03T01:02:03.456Z");
  const key = "u/user-1/drive/0b0f6c1e-aaaa-4bbb-8ccc-ddddeeeeffff";

  async function sign(config: Partial<S3StoreConfig>, downloadName = "보고서 (최종)*'!.pdf") {
    const store = new S3ObjectStore(configFor(config), { now: () => NOW });
    const signed = await store.signedDownloadUrl(key, { expiresInSeconds: 120, downloadName });
    return new URL(signed.url);
  }

  function expectedSignature(url: URL): string {
    return referenceSignature({
      method: "GET",
      path: decodeURIComponent(url.pathname),
      query: [...url.searchParams].filter(([name]) => name !== "X-Amz-Signature"),
      headers: { host: url.host },
      payloadHash: "UNSIGNED-PAYLOAD",
      datetime: "20261003T010203Z",
      region: "auto",
      service: "s3",
      secretAccessKey: SECRET,
    });
  }

  it("path style: host from the endpoint, bucket then key in the path (R2, MinIO)", async () => {
    const url = await sign({ endpoint: "https://acct.r2.cloudflarestorage.com" });
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/klorn-test/${key}`);
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(url));
  });

  it("path style keeps an endpoint's base path (Supabase Storage)", async () => {
    const url = await sign({ endpoint: "https://proj.supabase.co/storage/v1/s3/" });
    expect(url.origin).toBe("https://proj.supabase.co");
    expect(url.pathname).toBe(`/storage/v1/s3/klorn-test/${key}`);
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(url));
  });

  it("virtual-hosted style puts the bucket in the host", async () => {
    const url = await sign({
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      forcePathStyle: false,
    });
    expect(url.origin).toBe("https://klorn-test.s3.eu-west-1.amazonaws.com");
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(url));
  });

  it("signs the expiry, the date and the credential scope it was given", async () => {
    const url = await sign({ endpoint: "https://acct.r2.cloudflarestorage.com" });
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261003T010203Z");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      `${ACCESS_KEY}/20261003/auto/s3/aws4_request`,
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.toString()).not.toContain(SECRET);
  });

  it("gives a download name no way to change the host, the bucket or the key", async () => {
    const hostile = "https://evil.example/x?y#z/../../other-bucket/@evil.example";
    const url = await sign({ endpoint: "https://acct.r2.cloudflarestorage.com" }, hostile);
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/klorn-test/${key}`);
    expect(url.hash).toBe("");
  });

  it("refuses a config it cannot address safely", () => {
    const build = (config: Partial<S3StoreConfig>) => () => new S3ObjectStore(configFor(config));
    expect(build({ bucket: "../other" })).toThrow(StorageError);
    expect(build({ bucket: "a/b" })).toThrow(StorageError);
    expect(build({ endpoint: "not a url" })).toThrow(StorageError);
    expect(build({ endpoint: "https://user:pass@host.example" })).toThrow(StorageError);
    expect(build({ secretAccessKey: "" })).toThrow(StorageError);
  });
});

describe("S3ObjectStore failures", () => {
  it("maps a wrong secret to access-denied and echoes no credential", async () => {
    const store = new S3ObjectStore(configFor({ secretAccessKey: "wrong-secret-value-xyz" }));
    const err = await errorOf(() => store.ping());
    expect(err.code).toBe("access-denied");
    expect(err.status).toBe(403);
    expect(err.upstreamCode).toBe("SignatureDoesNotMatch");
    const printed = `${err.message}\n${err.stack}\n${JSON.stringify(err)}`;
    expect(printed).not.toContain("wrong-secret-value-xyz");
    expect(printed).not.toContain(ACCESS_KEY);
  });

  it("does not print its credentials when it is logged or serialised", async () => {
    const store = new S3ObjectStore(configFor());
    // One signed call, so the signing-key cache is populated too.
    await store.ping();
    const printed = `${inspect(store, { depth: 6, showHidden: true })}\n${JSON.stringify(store)}`;
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(ACCESS_KEY);
  });

  it("carries the vendor's status as `status`, never as an HTTP status for our own reply", async () => {
    // error-handler.ts answers with `error.statusCode`. A bucket's 403 or 404
    // must not become Klorn's answer to its own client.
    const store = new S3ObjectStore(configFor({ secretAccessKey: "wrong-secret-value-xyz" }));
    const err = await errorOf(() => store.ping());
    expect(err.status).toBe(403);
    expect("statusCode" in err).toBe(false);
  });

  it("maps a bucket that does not exist to bucket-not-found", async () => {
    const store = new S3ObjectStore(configFor({ bucket: "no-such-bucket" }));
    const err = await errorOf(() => store.ping());
    expect(err.code).toBe("bucket-not-found");
    expect(err.status).toBe(404);
    // A read must not report "no such object" when the bucket itself is missing.
    const key = newObjectKey("user-1", "drive");
    expect(await codeOfAsync(() => store.getObject(key))).toBe("bucket-not-found");
  });

  it("maps a refused connection to unreachable", async () => {
    const store = new S3ObjectStore(configFor({ endpoint: "http://127.0.0.1:1" }));
    expect((await errorOf(() => store.ping())).code).toBe("unreachable");
  });

  it("maps a 5xx to upstream and keeps the vendor's own code", async () => {
    const store = new S3ObjectStore(configFor());
    server.failNext("GET", 503, "SlowDown");
    const err = await errorOf(() => store.ping());
    expect(err.code).toBe("upstream");
    expect(err.status).toBe(503);
    expect(err.upstreamCode).toBe("SlowDown");
  });

  it("refuses a download with no usable length and releases the connection", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fakeFetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;
    const store = new S3ObjectStore(configFor(), { fetch: fakeFetch });
    const err = await errorOf(() => store.getObject(newObjectKey("user-1", "drive")));
    expect(err.code).toBe("upstream");
    expect(cancelled).toBe(true);
  });

  it("refuses a list answer larger than the cap without reading all of it", async () => {
    const { body, pulled } = endlessBody();
    const store = new S3ObjectStore(configFor(), { fetch: fetchAnswering(body, 200) });
    const err = await errorOf(() => store.ping());
    expect(err.code).toBe("upstream");
    expect(S3_MAX_LIST_BODY_BYTES).toBe(4 * 1024 * 1024);
    expect(pulled()).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it("reads only the start of an error body", async () => {
    const { body, pulled } = endlessBody();
    const store = new S3ObjectStore(configFor(), { fetch: fetchAnswering(body, 500) });
    const err = await errorOf(() => store.ping());
    expect(err.code).toBe("upstream");
    expect(err.status).toBe(500);
    expect(S3_MAX_ERROR_BODY_BYTES).toBe(16 * 1024);
    expect(pulled()).toBeLessThanOrEqual(512 * 1024);
  });

  it("maps a list answer that stalls and times out to a retryable StorageError", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException("The operation timed out", "TimeoutError"));
      },
    });
    const store = new S3ObjectStore(configFor(), { fetch: fetchAnswering(body, 200) });
    const err = await errorOf(() => store.ping());
    expect(err.code).toBe("unreachable");
    expect(err.retryable).toBe(true);
  });

  it("marks what is worth retrying, and only that", async () => {
    const store = new S3ObjectStore(configFor());
    server.failNext("GET", 503, "SlowDown");
    expect((await errorOf(() => store.ping())).retryable).toBe(true);
    server.failNext("GET", 429, "TooManyRequests");
    expect((await errorOf(() => store.ping())).retryable).toBe(true);
    server.failNext("GET", 400, "InvalidRequest");
    expect((await errorOf(() => store.ping())).retryable).toBe(false);
    const denied = new S3ObjectStore(configFor({ secretAccessKey: "wrong-secret-value-xyz" }));
    expect((await errorOf(() => denied.ping())).retryable).toBe(false);
    const down = new S3ObjectStore(configFor({ endpoint: "http://127.0.0.1:1" }));
    expect((await errorOf(() => down.ping())).retryable).toBe(true);
  });

  it("gives up on an endpoint that never answers", async () => {
    const silent = http.createServer(() => {
      // never answers
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const store = new S3ObjectStore(configFor({ endpoint: `http://127.0.0.1:${port}` }), {
        requestTimeoutMs: 50,
      });
      expect((await errorOf(() => store.ping())).code).toBe("unreachable");
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe("S3ObjectStore deleteByPrefix", () => {
  async function seed(store: S3ObjectStore, userId: string, count: number): Promise<string[]> {
    const keys: string[] = [];
    for (let index = 0; index < count; index++) {
      const key = newObjectKey(userId, "drive");
      await store.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
      keys.push(key);
    }
    return keys;
  }

  it("deletes nothing when the listing names a key outside the prefix", async () => {
    const store = new S3ObjectStore(configFor());
    const [victim = ""] = await seed(store, "victim-user", 1);
    server.listOverride = [victim];
    server.requests.length = 0;

    const err = await errorOf(() => store.deleteByPrefix(userPrefix("purged-user")));
    expect(err.code).toBe("upstream");
    expect(server.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
    expect(server.objects.has(victim)).toBe(true);
    server.objects.delete(victim);
  });

  it("never sends a delete for a key whose path would climb out of the prefix", async () => {
    // `..` and `.` segments are rewritten by every URL parser. A DELETE built
    // from such a key would land on another object, here another user's.
    const store = new S3ObjectStore(configFor());
    const victim = "u/victim-user/drive/x";
    server.objects.set(victim, { bytes: Buffer.from("x"), contentType: "a/b" });
    server.listOverride = [
      "u/purged-user/../victim-user/drive/x",
      "u/purged-user/./x",
      "u/purged-user/drive/..",
    ];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await errorOf(() => store.deleteByPrefix(userPrefix("purged-user")));
    expect(err.code).toBe("delete-incomplete");
    expect(err.retryable).toBe(false);
    expect(requestsOf("DELETE")).toHaveLength(0);
    expect(server.objects.has(victim)).toBe(true);
    server.objects.delete(victim);
  });

  it("deletes a stray key under the user's prefix, and warns once without naming it", async () => {
    // A key this code did not mint (an older grammar, a purpose added and then
    // rolled back, a manual upload) must not block the user's deletion for good.
    const store = new S3ObjectStore(configFor());
    await seed(store, "stray-user", 1);
    const strays = [
      "u/stray-user/legacy/report 1 (final).pdf",
      "u/stray-user/drive/보고서.txt",
      "u/stray-user/avatar/x+y&z=1!*'",
      // A "folder" made in a vendor console, and a doubled slash: both are
      // real keys, and a URL addresses each of them exactly.
      "u/stray-user/folder/",
      "u/stray-user/a//b",
    ];
    for (const key of strays)
      server.objects.set(key, { bytes: Buffer.from("x"), contentType: "a/b" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await store.deleteByPrefix(userPrefix("stray-user"))).toEqual({
      deleted: 6,
      more: false,
    });
    expect([...server.objects.keys()].filter((key) => key.startsWith("u/stray-user/"))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toContain("5 key");
    expect(warning).not.toContain("report");
  });

  it("deletes what it can address and reports the rest", async () => {
    const store = new S3ObjectStore(configFor());
    const [good = ""] = await seed(store, "mixed-user", 1);
    server.listOverride = [good, "u/mixed-user/../x"];
    server.requests.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await errorOf(() => store.deleteByPrefix(userPrefix("mixed-user")));
    expect(err.code).toBe("delete-incomplete");
    expect(requestsOf("DELETE")).toHaveLength(1);
    expect(server.objects.has(good)).toBe(false);
  });

  it("stops at the first failed batch instead of trying every key", async () => {
    const store = new S3ObjectStore(configFor());
    await seed(store, "failfast-user", 20);
    server.requests.length = 0;
    server.failNext("DELETE", 500, "InternalError");

    const err = await errorOf(() => store.deleteByPrefix(userPrefix("failfast-user")));
    expect(err.code).toBe("delete-incomplete");
    expect(err.retryable).toBe(true);
    expect(requestsOf("DELETE")).toHaveLength(S3_DELETE_CONCURRENCY);
    while ((await store.deleteByPrefix(userPrefix("failfast-user"))).more) {
      // finish the job so the stand-in is clean for the next test
    }
  });

  it("does nothing once its deadline has passed", async () => {
    const store = new S3ObjectStore(configFor());
    await seed(store, "late-user", 2);
    server.requests.length = 0;
    const err = await errorOf(() =>
      store.deleteByPrefix(userPrefix("late-user"), { signal: AbortSignal.abort() }),
    );
    expect(err.code).toBe("delete-incomplete");
    expect(err.retryable).toBe(true);
    expect(server.requests).toHaveLength(0);
    await store.deleteByPrefix(userPrefix("late-user"));
  });

  it("drops a request in flight when the deadline passes", async () => {
    const silent = http.createServer(() => {
      // never answers
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const store = new S3ObjectStore(configFor({ endpoint: `http://127.0.0.1:${port}` }));
      const started = Date.now();
      const err = await errorOf(() =>
        store.deleteByPrefix(userPrefix("late-user"), { signal: AbortSignal.timeout(50) }),
      );
      expect(err.retryable).toBe(true);
      // Far below the 15 s a single request is allowed on its own.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("reports a page whose deletes partly failed, and a retry finishes it", async () => {
    const store = new S3ObjectStore(configFor());
    await seed(store, "partial-user", 3);
    server.failNext("DELETE", 500, "InternalError");

    const err = await errorOf(() => store.deleteByPrefix(userPrefix("partial-user")));
    expect(err.code).toBe("delete-incomplete");
    expect(err.message).toContain("1 of 3");
    expect(await store.deleteByPrefix(userPrefix("partial-user"))).toEqual({
      deleted: 1,
      more: false,
    });
  });

  it("asks the bucket for one page of the requested prefix", async () => {
    const store = new S3ObjectStore(configFor(), { deletePageSize: 7 });
    await store.deleteByPrefix(userPrefix("nobody"));
    const list = server.requests.find((request) => request.method === "GET");
    expect(list?.path).toBe("/klorn-test");
  });
});

describe("parseListObjectsXml", () => {
  it("reads the keys and the truncation flag", () => {
    const xml =
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
      "<Contents><Key>u/a/drive/1</Key><Size>3</Size></Contents>" +
      "<Contents><Key>u/a/drive/2</Key></Contents></ListBucketResult>";
    expect(parseListObjectsXml(xml)).toEqual({
      keys: ["u/a/drive/1", "u/a/drive/2"],
      truncated: true,
    });
  });

  it("reads an empty result", () => {
    expect(
      parseListObjectsXml(
        '<?xml version="1.0"?><ListBucketResult xmlns="x"><KeyCount>0</KeyCount>' +
          "<IsTruncated>false</IsTruncated></ListBucketResult>",
      ),
    ).toEqual({ keys: [], truncated: false });
  });

  it("decodes XML entities in a key", () => {
    const xml =
      "<ListBucketResult><Contents><Key>a&amp;b&lt;c&gt;&quot;&apos;&#65;&#x42;&amp;lt;</Key>" +
      "</Contents></ListBucketResult>";
    expect(parseListObjectsXml(xml).keys).toEqual(["a&b<c>\"'AB&lt;"]);
  });

  it("refuses an answer that is not a list result", () => {
    expect(() => parseListObjectsXml("<html>login</html>")).toThrow(StorageError);
    expect(() => parseListObjectsXml("")).toThrow(StorageError);
  });
});

describe("s3ErrorCodeOf", () => {
  it("reads the vendor's error code", () => {
    expect(s3ErrorCodeOf("<Error><Code>NoSuchBucket</Code><Message>m</Message></Error>")).toBe(
      "NoSuchBucket",
    );
  });

  it("returns nothing for a body that carries no plain code", () => {
    expect(s3ErrorCodeOf("")).toBeUndefined();
    expect(s3ErrorCodeOf("<html>502</html>")).toBeUndefined();
    expect(s3ErrorCodeOf("<Error><Code>has spaces and <b>tags</b></Code></Error>")).toBeUndefined();
  });
});
