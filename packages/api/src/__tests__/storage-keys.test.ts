/**
 * Object keys (step D1 of docs/providers/unified-platform-plan.md). A key is
 * minted by the server and nothing a client sends becomes part of one. These
 * tests pin the grammar and the ownership check every user-level call relies on.
 */

import { describe, expect, it } from "vitest";
import {
  assertKeyBelongsToUser,
  isDeletablePrefix,
  keyBelongsToUser,
  newObjectKey,
  parseObjectKey,
  purposePrefix,
  STORAGE_PURPOSES,
  type StoragePurpose,
  userPrefix,
} from "../storage/keys.js";
import { codeOf } from "./helpers/storage-bytes.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const USER = "7f3c1e0a-1111-4222-8333-444455556666";
const OBJECT_ID = "0b0f6c1e-aaaa-4bbb-8ccc-ddddeeeeffff";

describe("newObjectKey", () => {
  it("mints u/<userId>/<purpose>/<uuid> and never repeats", () => {
    const a = newObjectKey(USER, "drive");
    const b = newObjectKey(USER, "drive");
    expect(a).toMatch(new RegExp(`^u/${USER}/drive/${UUID.source}$`));
    expect(a).not.toBe(b);
  });

  it("covers every purpose in the enum", () => {
    expect([...STORAGE_PURPOSES]).toEqual(["drive", "attachment"]);
    for (const purpose of STORAGE_PURPOSES) {
      expect(parseObjectKey(newObjectKey(USER, purpose))?.purpose).toBe(purpose);
    }
  });

  it.each([
    ["empty", ""],
    ["slash", "a/b"],
    ["traversal", ".."],
    ["dot", "a.b"],
    ["percent", "a%2Fb"],
    ["space", "a b"],
    ["query", "a?b"],
    ["too long", "a".repeat(65)],
  ])("refuses a user id that could change the path (%s)", (_label, userId) => {
    expect(codeOf(() => newObjectKey(userId, "drive"))).toBe("invalid-key");
  });

  it("refuses a purpose outside the enum", () => {
    expect(codeOf(() => newObjectKey(USER, "avatars" as StoragePurpose))).toBe("invalid-key");
    expect(codeOf(() => newObjectKey(USER, "../x" as StoragePurpose))).toBe("invalid-key");
  });
});

describe("parseObjectKey", () => {
  it("returns the parts of a well-formed key", () => {
    expect(parseObjectKey(`u/${USER}/attachment/${OBJECT_ID}`)).toEqual({
      userId: USER,
      purpose: "attachment",
      objectId: OBJECT_ID,
    });
  });

  it.each([
    ["a client file name as the last segment", `u/${USER}/drive/report.pdf`],
    ["an extra segment", `u/${USER}/drive/${OBJECT_ID}/report.pdf`],
    ["a traversal segment", `u/${USER}/drive/../${OBJECT_ID}`],
    ["an unknown purpose", `u/${USER}/avatars/${OBJECT_ID}`],
    ["an upper-case object id", `u/${USER}/drive/${OBJECT_ID.toUpperCase()}`],
    ["a leading slash", `/u/${USER}/drive/${OBJECT_ID}`],
    ["a trailing slash", `u/${USER}/drive/${OBJECT_ID}/`],
    ["a query string", `u/${USER}/drive/${OBJECT_ID}?x=1`],
    ["a trailing newline", `u/${USER}/drive/${OBJECT_ID}\n`],
    ["a different root", `x/${USER}/drive/${OBJECT_ID}`],
    ["an empty string", ""],
  ])("rejects %s", (_label, key) => {
    expect(parseObjectKey(key)).toBeNull();
  });

  it("rejects a non-string without throwing", () => {
    expect(parseObjectKey(undefined as unknown as string)).toBeNull();
    expect(parseObjectKey(42 as unknown as string)).toBeNull();
  });
});

describe("keyBelongsToUser", () => {
  it("accepts the user's own key", () => {
    expect(keyBelongsToUser(newObjectKey(USER, "drive"), USER)).toBe(true);
  });

  it("refuses another user's key", () => {
    expect(keyBelongsToUser(newObjectKey("someone-else", "drive"), USER)).toBe(false);
  });

  it("refuses a user whose id merely starts with this user's id", () => {
    // "abc" must not own "u/abcd/…": the prefix ends at the slash.
    expect(keyBelongsToUser(`u/abcd/drive/${OBJECT_ID}`, "abc")).toBe(false);
    expect(keyBelongsToUser(`u/abc/drive/${OBJECT_ID}`, "abcd")).toBe(false);
  });

  it("refuses a malformed key even under the right prefix", () => {
    expect(keyBelongsToUser(`u/${USER}/drive/../../other/drive/${OBJECT_ID}`, USER)).toBe(false);
    expect(keyBelongsToUser(`u/${USER}/drive/report.pdf`, USER)).toBe(false);
  });

  it("refuses an invalid user id", () => {
    expect(keyBelongsToUser(`u//drive/${OBJECT_ID}`, "")).toBe(false);
  });
});

describe("assertKeyBelongsToUser", () => {
  it("passes for the owner", () => {
    expect(codeOf(() => assertKeyBelongsToUser(`u/${USER}/drive/${OBJECT_ID}`, USER))).toBe(
      "no-error",
    );
  });

  it("throws key-not-owned for a well-formed key of another user", () => {
    expect(codeOf(() => assertKeyBelongsToUser(`u/other/drive/${OBJECT_ID}`, USER))).toBe(
      "key-not-owned",
    );
  });

  it("throws invalid-key for a malformed key", () => {
    expect(codeOf(() => assertKeyBelongsToUser(`u/${USER}/drive/report.pdf`, USER))).toBe(
      "invalid-key",
    );
  });
});

describe("prefixes", () => {
  it("ends every prefix with a slash", () => {
    expect(userPrefix("abc")).toBe("u/abc/");
    expect(purposePrefix("abc", "drive")).toBe("u/abc/drive/");
  });

  it("refuses to build a prefix from an invalid user id", () => {
    expect(codeOf(() => userPrefix(""))).toBe("invalid-key");
    expect(codeOf(() => userPrefix("a/b"))).toBe("invalid-key");
  });

  it.each([
    ["u/abc/", true],
    ["u/abc/drive/", true],
    ["u/abc/attachment/", true],
    ["u/abc", false],
    ["u/abc/drive", false],
    ["u/abc/avatars/", false],
    [`u/abc/drive/${OBJECT_ID}`, false],
    ["u/", false],
    ["u//", false],
    ["", false],
    ["/", false],
    ["u/abc/../", false],
  ])("isDeletablePrefix(%j) is %s", (prefix, expected) => {
    expect(isDeletablePrefix(prefix)).toBe(expected);
  });
});
