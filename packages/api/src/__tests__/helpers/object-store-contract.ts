/**
 * The contract every ObjectStore implementation must keep (step D1 of
 * docs/providers/unified-platform-plan.md). It runs against the in-memory fake,
 * against the S3 implementation talking to a local stand-in server, and, when
 * OBJECT_STORAGE_TEST_* is set, against a real bucket.
 *
 * Each test works under user ids it mints itself and deletes what it wrote, so
 * the suite is safe on a shared bucket.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { newObjectKey, userPrefix } from "../../storage/keys.js";
import type { ObjectStore, ObjectStoreLimits } from "../../storage/object-store.js";
import { bytesOf, chunksOf, codeOfAsync, collect, streamOf, textOf } from "./storage-bytes.js";

/** Per-object cap the contract stores are built with, so cap tests stay small. */
const SMALL_CAP_BYTES = 64;
/** Keys per bulk-delete page the contract stores are built with. */
const SMALL_PAGE = 2;

export interface ContractTarget {
  /** A store limited as given. Called once per test. */
  makeStore(limits: Required<ObjectStoreLimits>): ObjectStore | Promise<ObjectStore>;
  /** True when a signed URL can be fetched over HTTP (not the in-memory fake). */
  fetchesSignedUrls: boolean;
}

interface Harness {
  store: ObjectStore;
  /** A fresh user id whose objects are removed after the test. */
  newUser(): string;
}

function contractHarness(target: ContractTarget): () => Promise<Harness> {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  return async () => {
    const store = await target.makeStore({
      maxObjectBytes: SMALL_CAP_BYTES,
      deletePageSize: SMALL_PAGE,
    });
    const newUser = () => {
      const userId = `ct-${randomUUID()}`;
      cleanups.push(async () => {
        while ((await store.deleteByPrefix(userPrefix(userId))).more) {
          // keep going until the prefix is empty
        }
      });
      return userId;
    };
    return { store, newUser };
  };
}

export function describeObjectStoreContract(name: string, target: ContractTarget): void {
  describe(`ObjectStore contract — ${name}`, () => {
    const setup = contractHarness(target);

    describe("put, head, get, delete", () => {
      it("stores bytes and answers head and get with them", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        const meta = await store.putObject(key, bytesOf("hello klorn"), {
          contentType: "Text/Plain; charset=utf-8",
          size: 11,
        });
        expect(meta).toEqual({ key, size: 11, contentType: "text/plain" });
        expect(await store.headObject(key)).toEqual({ key, size: 11, contentType: "text/plain" });

        const got = await store.getObject(key);
        expect(got).not.toBeNull();
        expect(got?.size).toBe(11);
        expect(got?.contentType).toBe("text/plain");
        expect(got && (await textOf(got.body))).toBe("hello klorn");
      });

      it("uploads a stream that arrives in several chunks", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "attachment");
        const body = streamOf(bytesOf("abc"), bytesOf("defg"), bytesOf("hi"));
        await store.putObject(key, body, { contentType: "application/octet-stream", size: 9 });
        const got = await store.getObject(key);
        expect(got && (await textOf(got.body))).toBe("abcdefghi");
      });

      it("stores an empty object", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        await store.putObject(key, new Uint8Array(0), { contentType: "text/plain", size: 0 });
        expect((await store.headObject(key))?.size).toBe(0);
      });

      it("answers null for a key that holds nothing", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        expect(await store.headObject(key)).toBeNull();
        expect(await store.getObject(key)).toBeNull();
      });

      it("deletes an object, and deleting nothing is not an error", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        await store.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
        await store.deleteObject(key);
        expect(await store.headObject(key)).toBeNull();
        await expect(store.deleteObject(key)).resolves.toBeUndefined();
      });
    });

    describe("keys", () => {
      const malformed = [
        ["a client file name", (user: string) => `u/${user}/drive/report.pdf`],
        ["a traversal", (user: string) => `u/${user}/drive/../../x`],
        ["no user prefix", () => `drive/${randomUUID()}`],
        ["a query string", (user: string) => `u/${user}/drive/${randomUUID()}?acl`],
      ] as const;

      it.each(malformed)("refuses every operation on %s", async (_label, makeKey) => {
        const { store, newUser } = await setup();
        const key = makeKey(newUser());
        const put = () =>
          store.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
        const sign = () =>
          store.signedDownloadUrl(key, { expiresInSeconds: 60, downloadName: "x.txt" });
        expect(await codeOfAsync(put)).toBe("invalid-key");
        expect(await codeOfAsync(() => store.getObject(key))).toBe("invalid-key");
        expect(await codeOfAsync(() => store.headObject(key))).toBe("invalid-key");
        expect(await codeOfAsync(() => store.deleteObject(key))).toBe("invalid-key");
        expect(await codeOfAsync(sign)).toBe("invalid-key");
      });
    });

    describe("size cap", () => {
      it("refuses a declared size over the cap without reading the body", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        let pulled = false;
        const body = (async function* () {
          pulled = true;
          yield await Promise.resolve(new Uint8Array(SMALL_CAP_BYTES + 1));
        })();
        const put = () =>
          store.putObject(key, body, { contentType: "text/plain", size: SMALL_CAP_BYTES + 1 });
        expect(await codeOfAsync(put)).toBe("object-too-large");
        expect(pulled).toBe(false);
        expect(await store.headObject(key)).toBeNull();
      });

      it("aborts a stream that runs past the cap and stores nothing", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        // Declared at the cap, so the check before the upload passes.
        const body = chunksOf([40, 40]);
        const put = () =>
          store.putObject(key, body, { contentType: "text/plain", size: SMALL_CAP_BYTES });
        expect(await codeOfAsync(put)).toBe("object-too-large");
        expect(await store.headObject(key)).toBeNull();
      });

      it("aborts a stream longer than it declared and stores nothing", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        const put = () =>
          store.putObject(key, chunksOf([8, 8]), { contentType: "text/plain", size: 10 });
        expect(await codeOfAsync(put)).toBe("size-mismatch");
        expect(await store.headObject(key)).toBeNull();
      });

      it("fails a stream shorter than it declared and stores nothing", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        const put = () =>
          store.putObject(key, chunksOf([4]), { contentType: "text/plain", size: 10 });
        expect(await codeOfAsync(put)).toBe("size-mismatch");
        expect(await store.headObject(key)).toBeNull();
      });

      it("refuses a content type that is not a media type", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        const put = () =>
          store.putObject(key, bytesOf("x"), {
            contentType: "text/plain\r\nx-amz-acl: public-read",
            size: 1,
          });
        expect(await codeOfAsync(put)).toBe("invalid-content-type");
      });
    });

    describe("signed download URL", () => {
      it("pins the disposition to attachment and the type to octet-stream", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        await store.putObject(key, bytesOf("<script>alert(1)</script>"), {
          contentType: "text/html",
          size: 25,
        });
        const signed = await store.signedDownloadUrl(key, {
          expiresInSeconds: 60,
          downloadName: "page.html",
        });
        expect(signed.expiresInSeconds).toBe(60);
        const url = new URL(signed.url);
        expect(url.searchParams.get("response-content-disposition")).toBe(
          "attachment;filename=\"page.html\";filename*=UTF-8''page.html",
        );
        expect(url.searchParams.get("response-content-type")).toBe("application/octet-stream");
        expect(url.pathname.endsWith(`/${key}`)).toBe(true);
        // A space would travel as `+` or `%20` depending on the encoder.
        expect(signed.url).not.toContain("+");
      });

      it("cleans the download name before it reaches the URL", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        const signed = await store.signedDownloadUrl(key, {
          expiresInSeconds: 60,
          downloadName: '../../evil"\r\nX-Injected: 1.html',
        });
        const disposition = new URL(signed.url).searchParams.get("response-content-disposition");
        expect(disposition?.startsWith("attachment;")).toBe(true);
        expect(disposition).not.toMatch(/[\r\n/\\ ]/);
        expect(disposition?.match(/"/g)).toHaveLength(2);
      });

      it("refuses an expiry past the cap", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        const sign = (expiresInSeconds: number) => () =>
          store.signedDownloadUrl(key, { expiresInSeconds, downloadName: "a.txt" });
        expect(await codeOfAsync(sign(301))).toBe("expiry-too-long");
        expect(await codeOfAsync(sign(86_400))).toBe("expiry-too-long");
        expect(await codeOfAsync(sign(0))).toBe("invalid-expiry");
        expect(await codeOfAsync(sign(300))).toBe("no-error");
      });

      it.runIf(target.fetchesSignedUrls)(
        "serves the object as a download, never as a page",
        async () => {
          const { store, newUser } = await setup();
          const key = newObjectKey(newUser(), "drive");
          await store.putObject(key, bytesOf("<h1>hi</h1>"), {
            contentType: "text/html",
            size: 11,
          });
          const signed = await store.signedDownloadUrl(key, {
            expiresInSeconds: 60,
            downloadName: "보고서 최종.html",
          });
          const response = await fetch(signed.url);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("application/octet-stream");
          const disposition = response.headers.get("content-disposition") ?? "";
          expect(disposition.startsWith("attachment;")).toBe(true);
          expect(disposition).toContain(encodeURIComponent("보고서 최종.html"));
          expect(await response.text()).toBe("<h1>hi</h1>");
        },
      );

      it.runIf(target.fetchesSignedUrls)("is refused once it is tampered with", async () => {
        const { store, newUser } = await setup();
        const key = newObjectKey(newUser(), "drive");
        await store.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
        const signed = await store.signedDownloadUrl(key, {
          expiresInSeconds: 60,
          downloadName: "a.txt",
        });
        const inline = new URL(signed.url);
        inline.searchParams.set("response-content-disposition", "inline");
        expect((await fetch(inline)).status).toBe(403);
        const longer = new URL(signed.url);
        longer.searchParams.set("X-Amz-Expires", "604800");
        expect((await fetch(longer)).status).toBe(403);
      });
    });

    describe("deleteByPrefix", () => {
      async function seed(store: ObjectStore, userId: string, count: number): Promise<string[]> {
        const keys: string[] = [];
        for (let index = 0; index < count; index++) {
          const key = newObjectKey(userId, index % 2 === 0 ? "drive" : "attachment");
          await store.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
          keys.push(key);
        }
        return keys;
      }

      it("removes one user's objects page by page and leaves everyone else's", async () => {
        const { store, newUser } = await setup();
        const user = newUser();
        // A second user whose id merely extends the first one's.
        const neighbour = `${user}x`;
        const mine = await seed(store, user, 5);
        const [theirs] = await seed(store, neighbour, 1);

        const first = await store.deleteByPrefix(userPrefix(user));
        expect(first).toEqual({ deleted: SMALL_PAGE, more: true });

        let deleted = first.deleted;
        let more = first.more;
        while (more) {
          const next = await store.deleteByPrefix(userPrefix(user));
          deleted += next.deleted;
          more = next.more;
        }
        expect(deleted).toBe(5);
        for (const key of mine) expect(await store.headObject(key)).toBeNull();
        expect(theirs && (await store.headObject(theirs))).not.toBeNull();

        while ((await store.deleteByPrefix(userPrefix(neighbour))).more) {
          // clean the neighbour up: it was not minted through newUser()
        }
      });

      it("answers zero for a prefix that holds nothing", async () => {
        const { store, newUser } = await setup();
        expect(await store.deleteByPrefix(userPrefix(newUser()))).toEqual({
          deleted: 0,
          more: false,
        });
      });

      it.each([
        ["the empty prefix", ""],
        ["the root", "u/"],
        ["a prefix without its trailing slash", "u/abc"],
        ["an object key", `u/abc/drive/${randomUUID()}`],
        ["a traversal", "u/abc/../"],
      ])("refuses %s", async (_label, prefix) => {
        const { store } = await setup();
        expect(await codeOfAsync(() => store.deleteByPrefix(prefix))).toBe("invalid-prefix");
      });
    });

    describe("ping", () => {
      it("resolves for a reachable store", async () => {
        const { store } = await setup();
        await expect(store.ping()).resolves.toBeUndefined();
      });
    });

    it("hands back independent bytes: a caller cannot edit what is stored", async () => {
      const { store, newUser } = await setup();
      const key = newObjectKey(newUser(), "drive");
      const original = bytesOf("abc");
      await store.putObject(key, original, { contentType: "text/plain", size: 3 });
      original.fill(0);
      const got = await store.getObject(key);
      expect(got && Buffer.from(await collect(got.body)).toString("utf8")).toBe("abc");
    });
  });
}
