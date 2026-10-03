/**
 * The user-scoped storage layer (step D1). Every call names the user it acts
 * for, and a key outside that user's prefix is refused before the store is
 * touched. This is the layer D3, D4 and E4 call.
 */

import { describe, expect, it, vi } from "vitest";
import { newObjectKey, parseObjectKey } from "../storage/keys.js";
import { allowAnyContentType, allowContentTypes } from "../storage/limits.js";
import { MemoryObjectStore } from "../storage/memory-store.js";
import type { ObjectStore } from "../storage/object-store.js";
import { createUserStorage } from "../storage/user-storage.js";
import { bytesOf, chunksOf, codeOfAsync, textOf } from "./helpers/storage-bytes.js";

const ALICE = "alice-0001";
const BOB = "bob-0002";
const TEXT = { contentType: "text/plain", size: 5, contentTypePolicy: allowAnyContentType };

function setup(limits = {}) {
  const store = new MemoryObjectStore(limits);
  return { store, storage: createUserStorage(store) };
}

/** Spies on every store method, to prove a refused call never reached it. */
function spyOnStore(store: ObjectStore) {
  return {
    get: vi.spyOn(store, "getObject"),
    head: vi.spyOn(store, "headObject"),
    delete: vi.spyOn(store, "deleteObject"),
    sign: vi.spyOn(store, "signedDownloadUrl"),
    put: vi.spyOn(store, "putObject"),
  };
}

describe("put", () => {
  it("mints the key under the user's prefix and stores the bytes", async () => {
    const { store, storage } = setup();
    const meta = await storage.put(ALICE, "drive", bytesOf("hello"), TEXT);
    expect(parseObjectKey(meta.key)).toMatchObject({ userId: ALICE, purpose: "drive" });
    expect(store.keys()).toEqual([meta.key]);
    expect(meta).toMatchObject({ size: 5, contentType: "text/plain" });
  });

  it("asks the caller's policy about the normalised type and obeys a refusal", async () => {
    const { store, storage } = setup();
    const policy = vi.fn(allowContentTypes(["application/pdf"]));
    const spies = spyOnStore(store);
    const put = () =>
      storage.put(ALICE, "attachment", bytesOf("<b>x</b>"), {
        contentType: "Text/HTML; charset=utf-8",
        size: 8,
        contentTypePolicy: policy,
      });
    expect(await codeOfAsync(put)).toBe("content-type-refused");
    expect(policy).toHaveBeenCalledWith("text/html");
    expect(spies.put).not.toHaveBeenCalled();
    expect(store.keys()).toEqual([]);
  });

  it("refuses a value that is not a media type before asking the policy", async () => {
    const { storage } = setup();
    const policy = vi.fn(allowAnyContentType);
    const put = () =>
      storage.put(ALICE, "drive", bytesOf("x"), {
        contentType: "nonsense",
        size: 1,
        contentTypePolicy: policy,
      });
    expect(await codeOfAsync(put)).toBe("invalid-content-type");
    expect(policy).not.toHaveBeenCalled();
  });

  it("applies a caller's lower cap before the upload", async () => {
    const { store, storage } = setup();
    const spies = spyOnStore(store);
    const put = () =>
      storage.put(ALICE, "drive", chunksOf([11]), { ...TEXT, size: 11, maxBytes: 10 });
    expect(await codeOfAsync(put)).toBe("object-too-large");
    expect(spies.put).not.toHaveBeenCalled();
  });

  it("applies a caller's lower cap during the upload", async () => {
    const { store, storage } = setup();
    const put = () =>
      storage.put(ALICE, "drive", chunksOf([6, 6]), { ...TEXT, size: 10, maxBytes: 10 });
    expect(await codeOfAsync(put)).toBe("object-too-large");
    expect(store.keys()).toEqual([]);
  });

  it("cannot raise the store's cap", async () => {
    const { store, storage } = setup({ maxObjectBytes: 64 });
    const put = () =>
      storage.put(ALICE, "drive", chunksOf([100]), { ...TEXT, size: 100, maxBytes: 1000 });
    expect(await codeOfAsync(put)).toBe("object-too-large");
    expect(store.keys()).toEqual([]);
  });

  it("refuses a user id that cannot be a path segment", async () => {
    const { storage } = setup();
    expect(await codeOfAsync(() => storage.put("../bob", "drive", bytesOf("hello"), TEXT))).toBe(
      "invalid-key",
    );
  });
});

describe("ownership", () => {
  async function seeded() {
    const { store, storage } = setup();
    const mine = (await storage.put(ALICE, "drive", bytesOf("alice"), TEXT)).key;
    const theirs = (await storage.put(BOB, "drive", bytesOf("bobby"), TEXT)).key;
    return { store, storage, mine, theirs, spies: spyOnStore(store) };
  }
  const download = { expiresInSeconds: 60, downloadName: "a.txt" };

  it("serves the owner", async () => {
    const { storage, mine } = await seeded();
    const got = await storage.get(ALICE, mine);
    expect(got && (await textOf(got.body))).toBe("alice");
    expect((await storage.head(ALICE, mine))?.size).toBe(5);
    expect((await storage.signedDownloadUrl(ALICE, mine, download)).url).toContain(mine);
    await storage.delete(ALICE, mine);
    expect(await storage.head(ALICE, mine)).toBeNull();
  });

  it("refuses every call on another user's key, and the store never hears of it", async () => {
    const { store, storage, theirs, spies } = await seeded();
    expect(await codeOfAsync(() => storage.get(ALICE, theirs))).toBe("key-not-owned");
    expect(await codeOfAsync(() => storage.head(ALICE, theirs))).toBe("key-not-owned");
    expect(await codeOfAsync(() => storage.delete(ALICE, theirs))).toBe("key-not-owned");
    expect(await codeOfAsync(() => storage.signedDownloadUrl(ALICE, theirs, download))).toBe(
      "key-not-owned",
    );
    expect(spies.get).not.toHaveBeenCalled();
    expect(spies.head).not.toHaveBeenCalled();
    expect(spies.delete).not.toHaveBeenCalled();
    expect(spies.sign).not.toHaveBeenCalled();
    expect(store.keys()).toContain(theirs);
  });

  it("refuses a user whose id only starts with the owner's id", async () => {
    const { storage } = setup();
    const key = newObjectKey("alice-00011", "drive");
    expect(await codeOfAsync(() => storage.get("alice-0001", key))).toBe("key-not-owned");
  });

  it("refuses a malformed key before the store is touched", async () => {
    const { storage, spies } = await seeded();
    const key = `u/${ALICE}/drive/../../${BOB}/drive/x`;
    expect(await codeOfAsync(() => storage.get(ALICE, key))).toBe("invalid-key");
    expect(await codeOfAsync(() => storage.delete(ALICE, key))).toBe("invalid-key");
    expect(spies.get).not.toHaveBeenCalled();
    expect(spies.delete).not.toHaveBeenCalled();
  });
});

describe("purgeUser", () => {
  it("removes every object of the user, page by page, and nobody else's", async () => {
    const { store, storage } = setup({ deletePageSize: 2 });
    for (let index = 0; index < 5; index++) {
      await storage.put(ALICE, index % 2 ? "drive" : "attachment", bytesOf("alice"), TEXT);
    }
    const theirs = (await storage.put(BOB, "drive", bytesOf("bobby"), TEXT)).key;

    expect(await storage.purgeUser(ALICE)).toEqual({ deleted: 5 });
    expect(store.keys()).toEqual([theirs]);
  });

  it("answers zero for a user who stored nothing", async () => {
    const { storage } = setup();
    expect(await storage.purgeUser(ALICE)).toEqual({ deleted: 0 });
  });

  it("passes a storage failure on instead of reporting success", async () => {
    const { store, storage } = setup();
    vi.spyOn(store, "deleteByPrefix").mockRejectedValue(new Error("bucket is down"));
    await expect(storage.purgeUser(ALICE)).rejects.toThrow("bucket is down");
  });

  it("fails when the store keeps saying more without deleting anything", async () => {
    const { store, storage } = setup();
    const spy = vi.spyOn(store, "deleteByPrefix").mockResolvedValue({ deleted: 0, more: true });
    expect(await codeOfAsync(() => storage.purgeUser(ALICE))).toBe("delete-incomplete");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("stops at the page bound and says the purge is incomplete", async () => {
    const store = new MemoryObjectStore({ deletePageSize: 1 });
    const storage = createUserStorage(store, { purgeMaxPages: 2 });
    for (let index = 0; index < 4; index++)
      await storage.put(ALICE, "drive", bytesOf("alice"), TEXT);
    expect(await codeOfAsync(() => storage.purgeUser(ALICE))).toBe("delete-incomplete");
    // Progress is kept: the two pages that ran did delete.
    expect(store.keys()).toHaveLength(2);
  });

  it("refuses a user id that cannot be a prefix", async () => {
    const { storage } = setup();
    expect(await codeOfAsync(() => storage.purgeUser(""))).toBe("invalid-key");
    expect(await codeOfAsync(() => storage.purgeUser("a/b"))).toBe("invalid-key");
  });
});
