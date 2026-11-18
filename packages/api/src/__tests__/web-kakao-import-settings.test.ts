/**
 * Settings → Integrations → KakaoTalk import (web): the panel's pure helpers,
 * and every `kakaoImport.*` key the panel uses exists in all three locales
 * with its placeholders intact.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KAKAO_UPLOAD_MAX_BYTES,
  type KakaoImportSummary,
  kakaoImportActive,
  kakaoImportFailure,
  kakaoImportPanelVisible,
  kakaoImportResult,
  kakaoImportWayOutOnly,
} from "../../../web/src/app/settings/_sections/kakao-import-settings";
import en from "../../../web/src/lib/locales/en";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import { KAKAO_MAX_FILE_BYTES } from "../kakao-import/parse.js";

const LOCALES: Record<string, Record<string, string>> = { en, ko, zh };

function summary(overrides: Partial<KakaoImportSummary> = {}): KakaoImportSummary {
  return {
    id: "imp-1",
    status: "DONE",
    format: "mobile-dotted",
    totalMessages: 900,
    windowMessages: 120,
    speakerCount: 2,
    windowStart: "2026-10-16T03:00:00.000Z",
    windowEnd: "2026-11-16T03:00:00.000Z",
    candidatesFound: 6,
    commitmentsCreated: 4,
    duplicatesSkipped: 1,
    errorCode: null,
    createdAt: "2026-11-15T03:00:00.000Z",
    processedAt: "2026-11-15T03:01:00.000Z",
    ...overrides,
  };
}

describe("kakaoImportPanelVisible", () => {
  it("is true only when /me says the import is open to this user", () => {
    expect(kakaoImportPanelVisible({ kakaoImport: true })).toBe(true);
    expect(kakaoImportPanelVisible({ kakaoImport: false })).toBe(false);
    expect(kakaoImportPanelVisible({})).toBe(false);
    expect(kakaoImportPanelVisible(null)).toBe(false);
  });
});

describe("kakaoImportWayOutOnly", () => {
  it("is true only when the import is closed to the user and /me says they own one", () => {
    expect(kakaoImportWayOutOnly({ kakaoImport: false, kakaoImportWayOut: true })).toBe(true);
    expect(kakaoImportWayOutOnly({ kakaoImportWayOut: true })).toBe(true);
    // Open: the whole panel, not the way-out one.
    expect(kakaoImportWayOutOnly({ kakaoImport: true, kakaoImportWayOut: true })).toBe(false);
    expect(kakaoImportWayOutOnly({ kakaoImport: false, kakaoImportWayOut: false })).toBe(false);
    expect(kakaoImportWayOutOnly({})).toBe(false);
    expect(kakaoImportWayOutOnly(null)).toBe(false);
  });
});

describe("the upload cap", () => {
  it("matches the API's", () => {
    expect(KAKAO_UPLOAD_MAX_BYTES).toBe(KAKAO_MAX_FILE_BYTES);
  });
});

describe("kakaoImportFailure", () => {
  it("maps a known API error code to its message", () => {
    expect(kakaoImportFailure(new Error('API 422: {"error":"x","code":"unknown-format"}'))).toBe(
      "kakaoImport.error.unknown-format",
    );
    expect(kakaoImportFailure(new Error('API 429: {"code":"rate-limited"}'))).toBe(
      "kakaoImport.error.rate-limited",
    );
  });

  it("falls back to the generic message for anything else", () => {
    expect(kakaoImportFailure(new Error('API 400: {"code":"__proto__"}'))).toBe(
      "kakaoImport.error.generic",
    );
    expect(kakaoImportFailure(new Error("network down"))).toBe("kakaoImport.error.generic");
    expect(kakaoImportFailure("nope")).toBe("kakaoImport.error.generic");
  });
});

describe("kakaoImportActive", () => {
  it("is true while the import waits or is being read", () => {
    expect(kakaoImportActive(summary({ status: "PENDING" }))).toBe(true);
    expect(kakaoImportActive(summary({ status: "PROCESSING" }))).toBe(true);
    expect(kakaoImportActive(summary({ status: "DONE" }))).toBe(false);
    expect(kakaoImportActive(summary({ status: "FAILED" }))).toBe(false);
  });
});

describe("kakaoImportResult", () => {
  it("summarises a finished import", () => {
    expect(kakaoImportResult(summary())).toEqual({
      key: "kakaoImport.result",
      vars: { created: "4", messages: "120" },
    });
  });

  it("says when it stopped early, expired or failed", () => {
    expect(kakaoImportResult(summary({ errorCode: "partial" }))).toEqual({
      key: "kakaoImport.result.partial",
      vars: { created: "4", messages: "120" },
    });
    expect(kakaoImportResult(summary({ status: "FAILED", errorCode: "expired" }))).toEqual({
      key: "kakaoImport.result.expired",
    });
    expect(
      kakaoImportResult(summary({ status: "FAILED", errorCode: "processing-failed" })),
    ).toEqual({
      key: "kakaoImport.result.failed",
    });
  });

  it("says it is waiting while it is", () => {
    expect(kakaoImportResult(summary({ status: "PENDING" }))).toEqual({
      key: "kakaoImport.result.waiting",
      vars: { messages: "120" },
    });
  });
});

describe("KakaoTalk import panel copy", () => {
  const panel = readFileSync(
    new URL("../../../web/src/app/settings/_sections/kakao-import-panel.tsx", import.meta.url),
    "utf8",
  );
  const helpers = readFileSync(
    new URL("../../../web/src/app/settings/_sections/kakao-import-settings.ts", import.meta.url),
    "utf8",
  );
  const used = [...panel.matchAll(/t\("(kakaoImport\.[a-zA-Z.-]+)"/g)].map((m) => m[1] as string);
  const fromHelpers = [...helpers.matchAll(/"(kakaoImport\.[a-zA-Z.-]+)"/g)].map(
    (m) => m[1] as string,
  );
  const codes = [...helpers.matchAll(/^ {2}"([a-z-]+)",$/gm)].map(
    (m) => `kakaoImport.error.${m[1]}`,
  );
  const statuses = ["PENDING", "PROCESSING", "DONE", "FAILED"].map(
    (s) => `kakaoImport.status.${s}`,
  );
  const keys = [...new Set([...used, ...fromHelpers, ...codes, ...statuses])];

  it("uses keys that exist in every locale, placeholders intact", () => {
    expect(keys.length).toBeGreaterThan(30);
    for (const [locale, table] of Object.entries(LOCALES)) {
      for (const key of keys) {
        const value = table[key];
        expect(value, `${locale} ${key}`).toBeTruthy();
        const placeholders = (en[key] ?? "").match(/\{[a-z]+\}/g) ?? [];
        for (const placeholder of placeholders) {
          expect(value, `${locale} ${key}`).toContain(placeholder);
        }
      }
    }
  });

  it("asks for consent that the file holds other people's messages, in every locale", () => {
    expect(panel).toContain('t("kakaoImport.consent")');
    for (const table of Object.values(LOCALES)) expect(table["kakaoImport.consent"]).toBeTruthy();
  });
});
