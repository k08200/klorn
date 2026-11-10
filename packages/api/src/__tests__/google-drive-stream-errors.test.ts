/**
 * D5d review: what a Google error looks like on the wire, through the REAL
 * googleapis and gaxios, against a local HTTP server this file starts and stops
 * (the client's rootUrl points at it; no request leaves 127.0.0.1, and the
 * token is never refreshed: it does not expire and there is no refresh token).
 *
 * A streamed request (the summary's export or alt=media) that Google refuses
 * carries its JSON body in the error's MESSAGE only: gaxios leaves `errors` and
 * `response.data` unset. The reason (`exportSizeLimitExceeded`,
 * `userRateLimitExceeded`) must still be read, or a too-large export would read
 * as a hard failure and a rate limit would never be retried.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({ rootUrl: "" }));

vi.mock("googleapis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("googleapis")>();
  // The real client, with every Drive call sent to the local server.
  const google = new Proxy(actual.google, {
    get(target, prop, receiver) {
      if (prop === "drive") {
        return (options: Record<string, unknown>) =>
          target.drive({ ...options, rootUrl: local.rootUrl } as never);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, google };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { google } from "googleapis";
import { googleDriveSession } from "../drive/providers/google.js";
import {
  googleErrorReason,
  isGoogleExportTooLarge,
  isGoogleRateLimited,
} from "../drive/providers/google-files.js";
import { StorageError } from "../storage/errors.js";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const DOC = "application/vnd.google-apps.document";

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly type?: string;
}

let server: Server;
let answer: Answer = { status: 200, body: "" };
const seen: string[] = [];

function refusal(status: number, reason: string): Answer {
  const body = JSON.stringify({
    error: {
      code: status,
      message: "Refused.",
      errors: [{ message: "Refused.", domain: "global", reason }],
    },
  });
  return { status, body, type: "application/json; charset=UTF-8" };
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  seen.push(`${req.method} ${req.url}`);
  res.writeHead(answer.status, { "content-type": answer.type ?? "text/plain" });
  res.end(answer.body);
}

function client() {
  const auth = new google.auth.OAuth2("client-id", "client-secret");
  auth.setCredentials({ access_token: "ya29.local-test", expiry_date: Date.now() + 3_600_000 });
  return { client: auth, id: "acct-1", email: "me@example.com" };
}

const session = () => googleDriveSession(client() as never);
const fetchBytes = (mimeType: string) =>
  session().fetchForSummary(ID, { maxBytes: 1_000, mimeType });

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  local.rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

describe("gaxios' shape of a refused streamed request", () => {
  it("the body is in the message only: no `errors`, no `response.data`", async () => {
    answer = refusal(403, "exportSizeLimitExceeded");
    const api = google.drive({ version: "v3", auth: client().client });
    const err = await api.files
      .export({ fileId: ID, mimeType: "text/plain" }, { responseType: "stream" })
      .catch((e: unknown) => e as Record<string, unknown>);
    expect(seen).toEqual([`GET /drive/v3/files/${ID}/export?mimeType=text%2Fplain`]);
    expect(err.status).toBe(403);
    expect(err.errors).toBeUndefined();
    expect((err.response as { data?: unknown }).data).toBeUndefined();
    expect(err.message).toContain('"reason":"exportSizeLimitExceeded"');
    // What this module reads from it.
    expect(googleErrorReason(err)).toBe("exportSizeLimitExceeded");
    expect(isGoogleExportTooLarge(err)).toBe(true);
  });
});

describe("fetchForSummary over the real client", () => {
  it("a Doc's export arrives as a stream and is read whole", async () => {
    answer = { status: 200, body: "Minutes of the review." };
    expect(await fetchBytes(DOC)).toEqual({
      ok: true,
      bytes: Buffer.from("Minutes of the review."),
    });
    expect(seen).toEqual([`GET /drive/v3/files/${ID}/export?mimeType=text%2Fplain`]);
  });

  it("exportSizeLimitExceeded is too-large", async () => {
    answer = refusal(403, "exportSizeLimitExceeded");
    expect(await fetchBytes(DOC)).toEqual({ ok: false, reason: "too-large" });
  });

  it.each([
    "userRateLimitExceeded",
    "rateLimitExceeded",
  ])("a 403 %s on alt=media is a retryable StorageError", async (reason) => {
    answer = refusal(403, reason);
    const thrown = await fetchBytes("application/pdf").catch((e: unknown) => e);
    expect(seen).toEqual([`GET /drive/v3/files/${ID}?alt=media&supportsAllDrives=true`]);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).retryable).toBe(true);
    expect((thrown as StorageError).message).toBe(`Google Drive answered 403 ${reason}`);
  });

  it("a 403 fileNotDownloadable is a StorageError that is not retried", async () => {
    answer = refusal(403, "fileNotDownloadable");
    const thrown = await fetchBytes("application/pdf").catch((e: unknown) => e);
    expect((thrown as StorageError).retryable).toBe(false);
    expect((thrown as StorageError).message).toBe("Google Drive answered 403 fileNotDownloadable");
  });

  it("a 404 is null", async () => {
    answer = refusal(404, "notFound");
    expect(await fetchBytes("application/pdf")).toBeNull();
  });
});

describe("getMetadata's refusals over the real client (the refresh reads these)", () => {
  it("a JSON request's 403 rate limit is read as one", async () => {
    answer = refusal(403, "userRateLimitExceeded");
    const err = await session()
      .getMetadata(ID)
      .catch((e: unknown) => e);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^GET /drive/v3/files/${ID}\\?fields=`));
    expect(isGoogleRateLimited(err)).toBe(true);
  });

  it("a project-wide 403 names its reason", async () => {
    answer = refusal(403, "accessNotConfigured");
    const err = await session()
      .getMetadata(ID)
      .catch((e: unknown) => e);
    expect(googleErrorReason(err)).toBe("accessNotConfigured");
    expect(isGoogleRateLimited(err)).toBe(false);
  });
});
