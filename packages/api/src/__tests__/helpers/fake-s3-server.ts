/**
 * A small S3 stand-in over real HTTP, for the storage tests (step D1). There is
 * no bucket yet (founder action FA-7), so this is the only place the store's
 * requests travel over a socket. It models what those tests depend on:
 *
 *   - every request is verified with the independent SigV4 reference
 *     (`sigv4-reference.ts`), header-signed or presigned, including the expiry
 *     of a presigned URL. A request the store builds wrongly gets 403;
 *   - PUT needs a Content-Length (411 without one, as S3 answers) and stores
 *     nothing unless the whole body arrives;
 *   - PUT stores Content-Type, Content-Disposition and `x-amz-meta-*`, and GET
 *     and HEAD answer with them, as S3 does;
 *   - GET honours `response-content-disposition` and `response-content-type`,
 *     unless `ignoreResponseOverrides` is set (a vendor that drops them);
 *   - `commitThenFail` stores a PUT and then answers an error, the way a lost
 *     response looks to the client;
 *   - ListObjectsV2 with `prefix` and `max-keys`, answering IsTruncated;
 *   - DELETE is idempotent (204), HEAD answers 404 without a body;
 *   - path-style addressing only, one bucket.
 *
 * What it does NOT prove: that a real vendor canonicalises the same way. That
 * needs the real-bucket run (`storage-s3-real-bucket.test.ts`).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { referenceSignature } from "./sigv4-reference.js";

export interface FakeS3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  bodyBytes: number;
  /** False when the client went away before the body was complete. */
  completed: boolean;
}

interface StoredEntry {
  bytes: Buffer;
  contentType: string;
  /** The Content-Disposition sent with the PUT, when there was one. */
  contentDisposition?: string;
  /** `x-amz-meta-*` headers sent with the PUT, by full header name. */
  metadata?: Record<string, string>;
}

interface ForcedFailure {
  /** Only requests with this method are failed. */
  method: string;
  status: number;
  code: string;
  /** How many matching requests to fail. */
  times: number;
}

interface Reply {
  status: number;
  headers: http.OutgoingHttpHeaders;
  payload: string | Buffer;
}

function reply(
  status: number,
  headers: http.OutgoingHttpHeaders = {},
  payload: string | Buffer = "",
): Reply {
  return { status, headers, payload };
}

function failure(status: number, code: string): Reply {
  return reply(status, { "content-type": "application/xml" }, errorXml(code));
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorXml(code: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>fake</Message></Error>`;
}

function parseAmzDate(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

export class FakeS3Server {
  readonly objects = new Map<string, StoredEntry>();
  readonly requests: RecordedRequest[] = [];
  /** Keys the next list answers with, whatever the prefix. For hostile-answer tests. */
  listOverride: string[] | null = null;
  /** Answer GET as a vendor that ignores the `response-*` query overrides would. */
  ignoreResponseOverrides = false;
  /** Store the next PUT, then answer it with this error (a lost response). */
  commitThenFail: { status: number; code: string } | null = null;
  private forced: ForcedFailure | null = null;
  private server: http.Server | null = null;

  constructor(private readonly config: FakeS3Config) {}

  /** Start listening on a free loopback port. Resolves with the endpoint URL. */
  async start(): Promise<string> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Fail the next `times` requests of one method with this status and S3 error code. */
  failNext(method: string, status: number, code: string, times = 1): void {
    this.forced = { method, status, code, times };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    const body = await this.readBody(req);
    this.requests.push({
      method,
      path: url.pathname,
      headers: req.headers,
      bodyBytes: body.bytes.byteLength,
      completed: body.completed,
    });
    if (!body.completed) return;

    const answer = this.route(method, url, req.headers, body.bytes);
    res.writeHead(answer.status, answer.headers);
    res.end(method === "HEAD" ? undefined : answer.payload);
  }

  private route(method: string, url: URL, headers: http.IncomingHttpHeaders, body: Buffer): Reply {
    const authError = this.verify(method, url, headers);
    if (authError) return failure(403, authError);
    if (this.forced && this.forced.method === method && this.forced.times > 0) {
      const { status, code } = this.forced;
      this.forced = { ...this.forced, times: this.forced.times - 1 };
      return failure(status, code);
    }

    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split("/");
    if (bucket !== this.config.bucket) return failure(404, "NoSuchBucket");
    const key = rest.join("/");
    return key ? this.object(method, key, url, headers, body) : this.list(method, url);
  }

  private readBody(req: http.IncomingMessage): Promise<{ bytes: Buffer; completed: boolean }> {
    return new Promise((resolve) => {
      const parts: Buffer[] = [];
      const done = (completed: boolean) => resolve({ bytes: Buffer.concat(parts), completed });
      req.on("data", (chunk: Buffer) => parts.push(chunk));
      req.on("end", () => done(true));
      req.on("error", () => done(false));
      req.on("close", () => {
        if (!req.complete) done(false);
      });
    });
  }

  /** Returns an S3 error code when the signature does not hold, else null. */
  private verify(method: string, url: URL, headers: http.IncomingHttpHeaders): string | null {
    const presigned = url.searchParams.get("X-Amz-Signature");
    const header = (name: string) => String(headers[name] ?? "");
    const base = {
      method,
      path: decodeURIComponent(url.pathname),
      region: this.config.region,
      service: "s3",
      secretAccessKey: this.config.secretAccessKey,
    };
    const credentialPrefix = `${this.config.accessKeyId}/`;

    if (presigned) {
      const query = [...url.searchParams].filter(([name]) => name !== "X-Amz-Signature");
      const datetime = url.searchParams.get("X-Amz-Date") ?? "";
      const expires = Number(url.searchParams.get("X-Amz-Expires"));
      if (!(url.searchParams.get("X-Amz-Credential") ?? "").startsWith(credentialPrefix)) {
        return "InvalidAccessKeyId";
      }
      if (!(parseAmzDate(datetime) + expires * 1000 >= Date.now())) return "AccessDenied";
      const expected = referenceSignature({
        ...base,
        query: query.map(([name, value]) => [name, value] as const),
        headers: { host: header("host") },
        payloadHash: "UNSIGNED-PAYLOAD",
        datetime,
      });
      return expected === presigned ? null : "SignatureDoesNotMatch";
    }

    const auth =
      /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
        header("authorization"),
      );
    if (!auth) return "AccessDenied";
    const [, credential = "", signedHeaders = "", signature] = auth;
    if (!credential.startsWith(credentialPrefix)) return "InvalidAccessKeyId";
    const expected = referenceSignature({
      ...base,
      query: [...url.searchParams].map(([name, value]) => [name, value] as const),
      headers: Object.fromEntries(signedHeaders.split(";").map((name) => [name, header(name)])),
      payloadHash: header("x-amz-content-sha256"),
      datetime: header("x-amz-date"),
    });
    return expected === signature ? null : "SignatureDoesNotMatch";
  }

  private list(method: string, url: URL): Reply {
    if (method !== "GET" || url.searchParams.get("list-type") !== "2") {
      return failure(405, "MethodNotAllowed");
    }
    const prefix = url.searchParams.get("prefix") ?? "";
    const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000");
    const matching =
      this.listOverride ?? [...this.objects.keys()].sort().filter((key) => key.startsWith(prefix));
    const page = matching.slice(0, maxKeys);
    const contents = page
      .map((key) => `<Contents><Key>${xmlEscape(key)}</Key><Size>1</Size></Contents>`)
      .join("");
    return reply(
      200,
      { "content-type": "application/xml" },
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.config.bucket}</Name>` +
        `<Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
        `<IsTruncated>${matching.length > page.length}</IsTruncated>${contents}</ListBucketResult>`,
    );
  }

  private object(
    method: string,
    key: string,
    url: URL,
    headers: http.IncomingHttpHeaders,
    body: Buffer,
  ): Reply {
    if (method === "PUT") {
      if (headers["content-length"] === undefined) return failure(411, "MissingContentLength");
      const metadata = Object.fromEntries(
        Object.entries(headers)
          .filter(([name]) => name.startsWith("x-amz-meta-"))
          .map(([name, value]) => [name, String(value)]),
      );
      const disposition = headers["content-disposition"];
      this.objects.set(key, {
        bytes: body,
        contentType: String(headers["content-type"] ?? "binary/octet-stream"),
        ...(disposition ? { contentDisposition: String(disposition) } : {}),
        metadata,
      });
      const lost = this.commitThenFail;
      this.commitThenFail = null;
      return lost ? failure(lost.status, lost.code) : reply(200, { etag: '"fake"' });
    }
    if (method === "DELETE") {
      this.objects.delete(key);
      return reply(204);
    }
    const entry = this.objects.get(key);
    if (method !== "GET" && method !== "HEAD") return failure(405, "MethodNotAllowed");
    if (!entry) return failure(404, "NoSuchKey");
    const override = (name: string) =>
      this.ignoreResponseOverrides ? null : url.searchParams.get(name);
    const disposition = override("response-content-disposition") ?? entry.contentDisposition;
    return reply(
      200,
      {
        ...entry.metadata,
        "content-type": override("response-content-type") ?? entry.contentType,
        "content-length": entry.bytes.byteLength,
        ...(disposition ? { "content-disposition": disposition } : {}),
      },
      entry.bytes,
    );
  }
}
