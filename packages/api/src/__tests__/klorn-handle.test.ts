/**
 * The handle of a Klorn address (step E1a of docs/providers/unified-platform-plan.md):
 * user-chosen, immutable, never reissued (L5), with a reserved list. These rules
 * decide which local parts can ever be claimed, so a mistake here is permanent.
 */

import { describe, expect, it } from "vitest";
import {
  handleSkeleton,
  isReservedHandle,
  KLORN_HANDLE_MAX_LENGTH,
  KLORN_HANDLE_MIN_LENGTH,
  normalizeHandle,
  RESERVED_HANDLES,
  validateHandle,
} from "../mail/klorn-handle.js";

describe("normalizeHandle", () => {
  it("trims and lowercases", () => {
    expect(normalizeHandle("  Jane.Doe ")).toBe("jane.doe");
  });
});

describe("validateHandle", () => {
  it.each([
    "jane",
    "jane.doe",
    "jane-doe",
    "jane_doe",
    "j4ne",
    "abc",
    "a1b2c3",
  ])("accepts %s", (handle) => {
    expect(validateHandle(handle)).toEqual({ ok: true, handle });
  });

  it("normalizes before it checks", () => {
    expect(validateHandle(" Jane.Doe ")).toEqual({ ok: true, handle: "jane.doe" });
  });

  it("refuses a handle shorter or longer than the limits", () => {
    expect(validateHandle("ab")).toEqual({ ok: false, reason: "length" });
    expect(validateHandle("a".repeat(KLORN_HANDLE_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: "length",
    });
    expect(validateHandle("a".repeat(KLORN_HANDLE_MIN_LENGTH)).ok).toBe(true);
    expect(validateHandle("a".repeat(KLORN_HANDLE_MAX_LENGTH)).ok).toBe(true);
  });

  it.each([
    ["a plus tag (no aliases, L2)", "jane+news"],
    ["a leading separator", ".jane"],
    ["a trailing separator", "jane-"],
    ["two separators in a row", "jane..doe"],
    ["mixed separators in a row", "jane.-doe"],
    ["a space", "jane doe"],
    ["an at sign", "jane@doe"],
    ["a non-ASCII letter", "jäne"],
    ["a homoglyph", "јane"],
    ["a slash", "jane/doe"],
  ])("refuses %s", (_name, handle) => {
    expect(validateHandle(handle)).toEqual({ ok: false, reason: "characters" });
  });

  it("refuses a reserved handle, whatever its case", () => {
    expect(validateHandle("Postmaster")).toEqual({ ok: false, reason: "reserved" });
    expect(validateHandle("demo")).toEqual({ ok: false, reason: "reserved" });
  });

  it("refuses a value that is not a string", () => {
    expect(validateHandle(undefined)).toEqual({ ok: false, reason: "length" });
    expect(validateHandle(42)).toEqual({ ok: false, reason: "length" });
  });
});

describe("handleSkeleton (what a reader would take for the same handle)", () => {
  it("drops the separators and folds the usual look-alikes", () => {
    expect(handleSkeleton("Post.Master")).toBe(handleSkeleton("postmaster"));
    expect(handleSkeleton("adm1n")).toBe(handleSkeleton("admin"));
    expect(handleSkeleton("kl0rn")).toBe(handleSkeleton("klorn"));
    expect(handleSkeleton("klom")).toBe(handleSkeleton("klorn"));
    expect(handleSkeleton("jane")).not.toBe(handleSkeleton("june"));
  });
});

describe("look-alikes of reserved names and of Klorn", () => {
  it.each([
    "post.master",
    "no_reply",
    "no.reply",
    "sup-port",
    "adm1n",
    "admln",
    "security.",
  ])("refuses %s as reserved (or malformed)", (handle) => {
    expect(validateHandle(handle).ok).toBe(false);
  });

  it.each(["klorn-support", "klornteam", "k1orn", "kl0rn.help", "myklorn", "the_klorn_team"])(
    "refuses %s: it reads as Klorn",
    (handle) => {
      expect(validateHandle(handle)).toEqual({ ok: false, reason: "reserved" });
    },
  );

  it("still accepts ordinary names", () => {
    for (const handle of ["jane.doe", "lorna", "kim", "carmen", "ian.wells"]) {
      expect(validateHandle(handle)).toEqual({ ok: true, handle });
    }
  });
});

describe("the reserved list", () => {
  it("holds the mail roles, Klorn's own and the published addresses", () => {
    for (const handle of [
      "postmaster",
      "abuse",
      "hostmaster",
      "webmaster",
      "mailer-daemon",
      "noreply",
      "no-reply",
      "root",
      "admin",
      "security",
      "support",
      "help",
      "info",
      "billing",
      "privacy",
      "legal",
      "klorn",
      "team",
      "hello",
      "founders",
      "sales",
      "demo",
      // CA/Browser Forum domain-validation local parts: a claim of one of these
      // could receive a certificate approval for the domain.
      "administrator",
      // RFC 2142.
      "noc",
      "marketing",
      "www",
      "ftp",
      "news",
      "usenet",
      "uucp",
      "listmaster",
      // Names a reader trusts.
      "official",
      "staff",
      "system",
      "contact",
      "verify",
      "account",
      "payments",
      "unsubscribe",
      "google",
      "stripe",
      "paddle",
      "resend",
    ]) {
      expect(isReservedHandle(handle)).toBe(true);
    }
  });

  it("is lowercase and every entry would otherwise be a valid handle", () => {
    for (const handle of RESERVED_HANDLES) {
      expect(handle).toBe(normalizeHandle(handle));
      expect(validateHandle(handle)).toEqual({ ok: false, reason: "reserved" });
    }
  });

  it("does not reserve an ordinary name", () => {
    expect(isReservedHandle("jane")).toBe(false);
  });
});
