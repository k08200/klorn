/**
 * Reader language for server-composed explanatory text (tier reasons, the
 * needs-reply reason line). The client's UI language wins over the stored
 * notification language, so a Korean UI never shows English reasons just
 * because the push-notification setting says English.
 *
 * Precedence: `lang` query → Accept-Language best match → stored
 * notificationLanguage → en.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const configFindUnique = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));

vi.mock("../db.js", () => {
  const prisma = { automationConfig: { findUnique: configFindUnique } };
  return { prisma, db: prisma };
});

import {
  bestAcceptLanguage,
  parseSupportedLanguage,
  resolveReaderLanguage,
} from "../notify/request-language.js";

beforeEach(() => {
  configFindUnique.mockReset();
  configFindUnique.mockResolvedValue(null);
});

describe("parseSupportedLanguage", () => {
  it.each(["en", "ko", "ja", "zh", "es", "fr", "de"])("accepts the UI locale %s", (code) => {
    expect(parseSupportedLanguage(code)).toBe(code);
  });

  it("accepts a region-tagged code by its base language, case-insensitively", () => {
    expect(parseSupportedLanguage("ko-KR")).toBe("ko");
    expect(parseSupportedLanguage("ZH_hans")).toBe("zh");
  });

  it.each([undefined, null, "", "xx", "pt", "klingon", "*", 42, ["ko"]])("ignores %s", (value) => {
    expect(parseSupportedLanguage(value)).toBeNull();
  });
});

describe("bestAcceptLanguage", () => {
  it("returns null without a header", () => {
    expect(bestAcceptLanguage(undefined)).toBeNull();
    expect(bestAcceptLanguage("")).toBeNull();
  });

  it("picks the highest-q supported language, not the first listed", () => {
    expect(bestAcceptLanguage("pt-BR;q=1, en;q=0.5, ko;q=0.9")).toBe("ko");
  });

  it("treats a missing q as 1 and keeps header order on ties", () => {
    expect(bestAcceptLanguage("ja, de")).toBe("ja");
    expect(bestAcceptLanguage("ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")).toBe("ko");
  });

  it("skips unsupported tags, wildcards and q=0", () => {
    expect(bestAcceptLanguage("pt, *, fr;q=0, es;q=0.1")).toBe("es");
    expect(bestAcceptLanguage("pt, *")).toBeNull();
  });

  it("reads the first value when the header arrives as an array", () => {
    expect(bestAcceptLanguage(["fr", "de"])).toBe("fr");
  });

  it("does not choke on a hostile header", () => {
    expect(bestAcceptLanguage(`${"x;q=1,".repeat(10_000)}ko`)).toBeNull();
    expect(bestAcceptLanguage("ko;q=abc")).toBe("ko");
  });
});

describe("resolveReaderLanguage — precedence", () => {
  it("1. a valid lang query wins over the header and the stored setting", async () => {
    configFindUnique.mockResolvedValue({ notificationLanguage: "en" });
    const lang = await resolveReaderLanguage({
      userId: "u1",
      lang: "ko",
      acceptLanguage: "de",
    });
    expect(lang).toBe("ko");
    expect(configFindUnique).not.toHaveBeenCalled();
  });

  it("2. an unknown lang is ignored and Accept-Language decides", async () => {
    configFindUnique.mockResolvedValue({ notificationLanguage: "en" });
    const lang = await resolveReaderLanguage({
      userId: "u1",
      lang: "xx",
      acceptLanguage: "ja-JP,ja;q=0.9",
    });
    expect(lang).toBe("ja");
    expect(configFindUnique).not.toHaveBeenCalled();
  });

  it("3. without lang or a supported header the stored notification language is used", async () => {
    configFindUnique.mockResolvedValue({ notificationLanguage: "fr" });
    const lang = await resolveReaderLanguage({
      userId: "u1",
      lang: "xx",
      acceptLanguage: "pt-BR",
    });
    expect(lang).toBe("fr");
  });

  it("4. with nothing at all it is English", async () => {
    configFindUnique.mockResolvedValue(null);
    expect(await resolveReaderLanguage({ userId: "u1" })).toBe("en");
  });

  it("4. a failing config read still answers English", async () => {
    configFindUnique.mockRejectedValue(new Error("db down"));
    expect(await resolveReaderLanguage({ userId: "u1" })).toBe("en");
  });
});
