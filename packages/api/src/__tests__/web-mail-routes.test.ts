/**
 * The phone reader is full screen (mobile redesign PR3, MB1): the shell finds
 * the reader route with packages/web/src/lib/mail-routes.ts, and only for the
 * Mail v2 reader. Pinned here so a list sub-page never loses its tab bar.
 */

import { describe, expect, it } from "vitest";
import {
  isFullScreenReader,
  isMailReaderPath,
  mailReaderId,
} from "../../../web/src/lib/mail-routes";

describe("mail reader route", () => {
  it("reads the id of /email/:id", () => {
    expect(mailReaderId("/email/e-1")).toBe("e-1");
    expect(mailReaderId("/email/a%20b/")).toBe("a b");
  });

  it("is not the list, its sub-pages or a nested route", () => {
    for (const path of [
      "/email",
      "/email/",
      "/email/candidates",
      "/email/subscriptions",
      "/email/candidates/c-1",
      "/today",
      "",
      null,
      undefined,
    ]) {
      expect(isMailReaderPath(path)).toBe(false);
    }
  });

  it("goes full screen for the Mail v2 reader only", () => {
    expect(isFullScreenReader("/email/e-1", { mailV2: true })).toBe(true);
    expect(isFullScreenReader("/email/e-1", { mailV2: false })).toBe(false);
    expect(isFullScreenReader("/email/e-1", null)).toBe(false);
    expect(isFullScreenReader("/email", { mailV2: true })).toBe(false);
  });
});
