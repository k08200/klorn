/**
 * The in-memory ObjectStore (step D1) keeps the same contract as the real one,
 * so D3, D4 and E4 can test against it and trust what they see.
 */

import { describe, expect, it } from "vitest";
import { newObjectKey } from "../storage/keys.js";
import { MAX_OBJECT_BYTES } from "../storage/limits.js";
import { MemoryObjectStore } from "../storage/memory-store.js";
import { describeObjectStoreContract } from "./helpers/object-store-contract.js";
import { bytesOf, codeOf } from "./helpers/storage-bytes.js";

describeObjectStoreContract("in-memory fake", {
  makeStore: (limits) => new MemoryObjectStore(limits),
  fetchesSignedUrls: false,
});

describe("MemoryObjectStore", () => {
  it("defaults to the production cap and never accepts a higher one", () => {
    expect(new MemoryObjectStore().maxObjectBytes).toBe(MAX_OBJECT_BYTES);
    expect(codeOf(() => new MemoryObjectStore({ maxObjectBytes: MAX_OBJECT_BYTES + 1 }))).toBe(
      "misconfigured",
    );
    expect(codeOf(() => new MemoryObjectStore({ maxObjectBytes: 0 }))).toBe("misconfigured");
  });

  it("lists what it holds, for assertions in other suites", async () => {
    const store = new MemoryObjectStore();
    const key = newObjectKey("user-1", "drive");
    expect(store.keys()).toEqual([]);
    await store.putObject(key, bytesOf("x"), { contentType: "text/plain", size: 1 });
    expect(store.keys()).toEqual([key]);
  });

  it("signs URLs on a host that resolves nowhere", async () => {
    const store = new MemoryObjectStore();
    const signed = await store.signedDownloadUrl(newObjectKey("user-1", "drive"), {
      expiresInSeconds: 30,
      downloadName: "a.txt",
    });
    expect(new URL(signed.url).hostname.endsWith(".invalid")).toBe(true);
  });
});
