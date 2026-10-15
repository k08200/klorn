import { describe, expect, it } from "vitest";
import { escapeLikePattern, likeContainsPattern } from "../db-like.js";

describe("escapeLikePattern", () => {
  it("escapes exactly the three characters LIKE gives a meaning to", () => {
    expect(escapeLikePattern("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(escapeLikePattern("plain.*(text)")).toBe("plain.*(text)");
  });

  it("leaves an email address without wildcards unchanged and escapes one with them", () => {
    expect(escapeLikePattern("alice@corp.com")).toBe("alice@corp.com");
    expect(escapeLikePattern("john_doe@corp.com")).toBe("john\\_doe@corp.com");
    expect(escapeLikePattern("%")).toBe("\\%");
  });

  it("is the empty string for the empty string", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});

describe("likeContainsPattern", () => {
  it("wraps the escaped term in % for a raw-SQL ILIKE", () => {
    expect(likeContainsPattern("50%_off")).toBe("%50\\%\\_off%");
  });
});
