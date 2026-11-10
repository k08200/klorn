import { describe, expect, it } from "vitest";
import { extractContentId } from "../mail/gmail-fetch.js";

describe("extractContentId", () => {
  it("strips angle brackets and returns null when absent", () => {
    expect(extractContentId({ headers: [{ name: "Content-ID", value: "<logo@mail>" }] })).toBe(
      "logo@mail",
    );
    expect(extractContentId({ headers: [{ name: "content-id", value: "bare@id" }] })).toBe(
      "bare@id",
    );
    expect(extractContentId({ headers: [] })).toBeNull();
    expect(extractContentId({})).toBeNull();
    expect(extractContentId({ headers: [{ name: "Content-ID", value: "<>" }] })).toBeNull();
  });

  it("rejects Content-IDs carrying control characters (crafted headers)", () => {
    for (const bad of ["evil\u0000null@mail", "line\nbreak@mail", "del\u007fchar@mail"]) {
      expect(extractContentId({ headers: [{ name: "Content-ID", value: `<${bad}>` }] })).toBeNull();
    }
    // Path-ish characters survive: they are legal in a cid and the desktop
    // client percent-encodes everything outside alphanumerics.
    expect(extractContentId({ headers: [{ name: "Content-ID", value: "<a/b..c@mail>" }] })).toBe(
      "a/b..c@mail",
    );
  });
});
