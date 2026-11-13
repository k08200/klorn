/**
 * Settings -> Accounts -> Account health (web/src/lib/account-health.ts): how a
 * connected mail account's status, last sync and failure read, in all 7 locales.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountSectionId,
  imapAccountStatus,
  lastSyncCopy,
  statusChip,
  syncProblemKey,
} from "../../../web/src/lib/account-health";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import { accountHealthStatus } from "../mail/account-health";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("lastSyncCopy", () => {
  it("reads just now, minutes, hours, days, never — and 'direct' for the Klorn address", () => {
    expect(lastSyncCopy(ago(20_000), NOW, "ICLOUD")).toEqual({ key: "accountHealth.sync.justNow" });
    expect(lastSyncCopy(ago(5 * 60_000), NOW, "ICLOUD")).toEqual({
      key: "accountHealth.sync.minutes",
      vars: { n: "5" },
    });
    expect(lastSyncCopy(ago(3 * 3_600_000), NOW, "OUTLOOK")).toEqual({
      key: "accountHealth.sync.hours",
      vars: { n: "3" },
    });
    expect(lastSyncCopy(ago(2 * 86_400_000), NOW, "GOOGLE")).toEqual({
      key: "accountHealth.sync.days",
      vars: { n: "2" },
    });
    expect(lastSyncCopy(null, NOW, "NAVER")).toEqual({ key: "accountHealth.sync.never" });
    expect(lastSyncCopy(null, NOW, "KLORN")).toEqual({ key: "accountHealth.sync.direct" });
  });
});

describe("syncProblemKey", () => {
  it("explains a refused iCloud password with Apple's own cause, others generically", () => {
    expect(syncProblemKey("reconnect", "auth", "ICLOUD")).toBe("accountHealth.error.authApple");
    expect(syncProblemKey("reconnect", null, "OUTLOOK")).toBe("accountHealth.error.auth");
    expect(syncProblemKey("error", "unreachable", "NAVER")).toBe("accountHealth.error.unreachable");
    expect(syncProblemKey("error", "throttled", "OUTLOOK")).toBe("accountHealth.error.throttled");
    expect(syncProblemKey("ok", null, "GOOGLE")).toBeNull();
    expect(syncProblemKey("pending", null, "ICLOUD")).toBeNull();
  });
});

describe("status", () => {
  it("never relies on color alone: every status has its own label", () => {
    const labels = (["ok", "pending", "error", "reconnect"] as const).map(
      (s) => statusChip(s).labelKey,
    );
    expect(new Set(labels).size).toBe(4);
  });

  it("an IMAP card and Account Health agree on every combination", () => {
    for (const needsReconnect of [true, false]) {
      for (const code of ["auth", "unreachable", null] as const) {
        for (const synced of [ago(60_000), null]) {
          const web = imapAccountStatus({
            email: "me@icloud.com",
            needsReconnect,
            syncErrorCode: code,
            lastSyncedAt: synced,
          });
          const api = accountHealthStatus({
            needsReconnect,
            errorCode: code,
            lastSyncedAt: synced ? new Date(synced) : null,
            polled: true,
          }).status;
          expect(web).toBe(api);
        }
      }
    }
  });

  it("links a reconnect to the account's own section in Settings -> Accounts", () => {
    expect(accountSectionId("ICLOUD", "linked")).toBe("account-icloud");
    expect(accountSectionId("GOOGLE", "primary")).toBe("account-connections");
    const page = readFileSync(
      join(__dirname, "../../../web/src/app/settings/_sections/accounts-section.tsx"),
      "utf8",
    );
    for (const id of [
      "account-connections",
      "account-google",
      "account-naver",
      "account-icloud",
      "account-outlook",
    ]) {
      expect(page).toContain(`id="${id}"`);
    }
    expect(page).toContain("<AccountHealthSection />");
  });

  it("shows sync status and the reconnect form on both IMAP cards", () => {
    for (const file of ["icloud-imap-section.tsx", "naver-imap-section.tsx"]) {
      const source = readFileSync(join(__dirname, "../../../web/src/components", file), "utf8");
      expect(source).toContain("<ImapAccountStatus");
    }
  });
});

describe("copy, all 7 locales", () => {
  const LOCALES = { en, ko, ja, zh, de, fr, es } as const;
  const KEYS = Object.keys(en).filter((key) => key.startsWith("accountHealth."));

  it("has the whole Account Health set", () => {
    expect(KEYS.length).toBe(24);
    for (const key of [
      "accountHealth.error.authApple",
      "accountHealth.error.unreachable",
      "accountHealth.error.throttled",
      "accountHealth.error.error",
      "accountHealth.action.reconnect",
    ]) {
      expect(KEYS).toContain(key);
    }
  });

  it("every locale has every key, non-empty, with the {n} placeholder kept", () => {
    for (const [locale, table] of Object.entries(LOCALES)) {
      for (const key of KEYS) {
        const value = (table as Record<string, string>)[key];
        expect(value, `${locale} ${key}`).toBeTruthy();
        if (en[key]?.includes("{n}")) expect(value, `${locale} ${key}`).toContain("{n}");
      }
    }
  });
});
