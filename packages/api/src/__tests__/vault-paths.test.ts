/**
 * Klorn Vault path sanitizer (vault/vault-paths.ts). Every archive path is
 * built from server-side values plus a slug of the subject or the sender's
 * address, both untrusted: no traversal, no absolute path, no drive letter,
 * no hidden file, no Windows device name, no character that breaks a
 * wiki-link, bounded length, Unicode kept readable.
 */

import { describe, expect, it } from "vitest";
import {
  isVaultPath,
  mailNotePath,
  PathRegistry,
  senderKeyOf,
  senderNotePath,
  slugify,
  VAULT_MAX_PATH_BYTES,
  VAULT_MAX_SEGMENT_BYTES,
} from "../vault/vault-paths.js";

const ID = "1a2b3c4d-5e6f-4a1b-9c2d-0123456789ab";

describe("slugify", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugify("Quarterly Report: Q4 (final)")).toBe("quarterly-report-q4-final");
  });

  it("keeps letters and numbers of every script", () => {
    expect(slugify("내일 3시 회의 확인")).toBe("내일-3시-회의-확인");
    expect(slugify("Réunion à 15h")).toBe("réunion-à-15h");
    expect(slugify("会议 确认")).toBe("会议-确认");
  });

  it("drops path separators, dots, wiki-link and shell characters", () => {
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify('a\\b:c*d?e"f<g>h|i#j^k[l]m%n')).toBe("a-b-c-d-e-f-g-h-i-j-k-l-m-n");
    expect(slugify("C:\\Windows\\System32")).toBe("c-windows-system32");
  });

  it("drops controls, bidi overrides and emoji", () => {
    expect(slugify("pay\u202Eexe.txt now 🔥")).toBe("payexe-txt-now");
  });

  it("caps by characters without splitting a character", () => {
    const slug = slugify("가".repeat(100), 10);
    expect(Array.from(slug)).toHaveLength(10);
    expect(slugify(`${"a".repeat(9)} bcd`, 10)).toBe("aaaaaaaaa");
  });

  it("falls back to 'untitled' when nothing usable is left", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("../..//")).toBe("untitled");
    expect(slugify("🔥🔥")).toBe("untitled");
  });
});

describe("mailNotePath", () => {
  it("files a mail under mail/YYYY/MM with date, slug and short id", () => {
    const paths = new PathRegistry();
    expect(mailNotePath({ dateKey: "2026-11-12", subject: "Hello there", id: ID }, paths)).toBe(
      "Klorn/mail/2026/11/2026-11-12-hello-there-1a2b3c4d.md",
    );
  });

  it("never yields the same path twice: a collision lengthens the id", () => {
    const paths = new PathRegistry();
    const a = mailNotePath({ dateKey: "2026-11-12", subject: "Hi", id: ID }, paths);
    const b = mailNotePath(
      { dateKey: "2026-11-12", subject: "Hi", id: "1a2b3c4d-ffff-4a1b-9c2d-0123456789ab" },
      paths,
    );
    expect(a).not.toBe(b);
    expect(b).toBe("Klorn/mail/2026/11/2026-11-12-hi-1a2b3c4dffff.md");
  });

  it("refuses a date key that is not YYYY-MM-DD", () => {
    const paths = new PathRegistry();
    expect(() => mailNotePath({ dateKey: "../../x", subject: "a", id: ID }, paths)).toThrow();
  });

  it("uses only hex from the id, whatever the id holds", () => {
    const paths = new PathRegistry();
    expect(mailNotePath({ dateKey: "2026-01-02", subject: "a", id: "../ZZ/12" }, paths)).toBe(
      "Klorn/mail/2026/01/2026-01-02-a-12.md",
    );
  });

  it("stays a valid vault path for a hostile 10k-character subject", () => {
    const paths = new PathRegistry();
    const path = mailNotePath(
      { dateKey: "2026-11-12", subject: `${"../".repeat(2000)}[[x]]${"가".repeat(5000)}`, id: ID },
      paths,
    );
    expect(isVaultPath(path)).toBe(true);
  });
});

describe("senderKeyOf", () => {
  it("groups an organisation's addresses under its domain", () => {
    expect(senderKeyOf("Boss@Corp.com")).toBe("corp.com");
  });

  it("keeps a public mail provider's sender as the address", () => {
    expect(senderKeyOf("alice@gmail.com")).toBe("alice@gmail.com");
  });

  it("falls back to 'unknown' for an empty address", () => {
    expect(senderKeyOf("")).toBe("unknown");
    expect(senderKeyOf(null)).toBe("unknown");
  });
});

describe("senderNotePath", () => {
  it("files a sender under senders/ by domain or address", () => {
    const paths = new PathRegistry();
    expect(senderNotePath("corp.com", paths)).toBe("Klorn/senders/corp.com.md");
    expect(senderNotePath("alice+tag@gmail.com", paths)).toBe(
      "Klorn/senders/alice+tag@gmail.com.md",
    );
  });

  it("gives the same key the same path and a different key a different one", () => {
    const paths = new PathRegistry();
    const a = senderNotePath("a/b.com", paths);
    expect(senderNotePath("a/b.com", paths)).toBe(a);
    const b = senderNotePath("a:b.com", paths);
    expect(b).not.toBe(a);
    expect(isVaultPath(b)).toBe(true);
    // The suffix comes from the key, so it is the same in every export.
    const other = new PathRegistry();
    other.claim("Klorn/senders/a-b.com.md");
    expect(senderNotePath("a:b.com", other)).toBe(b);
  });

  it("never runs out of paths, however many keys sanitize alike", () => {
    const paths = new PathRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) seen.add(senderNotePath(`a${"/".repeat(i + 1)}b.com`, paths));
    expect(seen.size).toBe(2_000);
  });

  it("does not end a sender file in .md.md", () => {
    expect(senderNotePath("corp.md", new PathRegistry())).toBe("Klorn/senders/corp_md.md");
  });

  it("never yields a hidden file, a traversal or a trailing dot", () => {
    const paths = new PathRegistry();
    expect(senderNotePath("..", paths)).toBe("Klorn/senders/unknown.md");
    expect(senderNotePath(".hidden.com.", paths)).toBe("Klorn/senders/hidden.com.md");
    expect(senderNotePath("a..b.com", paths)).toBe("Klorn/senders/a.b.com.md");
  });

  it("prefixes a Windows device name", () => {
    const paths = new PathRegistry();
    expect(senderNotePath("con.com", paths)).toBe("Klorn/senders/_con.com.md");
    expect(senderNotePath("LPT1", paths)).toBe("Klorn/senders/_lpt1.md");
    expect(senderNotePath("aux@gmail.com", paths)).toBe("Klorn/senders/aux@gmail.com.md");
  });

  it("caps a long key by bytes", () => {
    const paths = new PathRegistry();
    const path = senderNotePath(`${"가".repeat(300)}.com`, paths);
    const segment = path.split("/").at(-1) ?? "";
    expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(VAULT_MAX_SEGMENT_BYTES);
    expect(isVaultPath(path)).toBe(true);
  });
});

describe("isVaultPath", () => {
  it("accepts the layout's own paths", () => {
    for (const path of [
      "Klorn/_klorn.md",
      "Klorn/lanes/PUSH.md",
      "Klorn/commitments/active.md",
      "Klorn/senders/corp.com.md",
      "Klorn/mail/2026/11/2026-11-12-내일-회의-1a2b3c4d.md",
    ]) {
      expect(isVaultPath(path), path).toBe(true);
    }
  });

  it("refuses traversal, absolute paths, drive letters and backslashes", () => {
    for (const path of [
      "../Klorn/x.md",
      "Klorn/../x.md",
      "Klorn/./x.md",
      "/Klorn/x.md",
      "C:/Klorn/x.md",
      "Klorn\\x.md",
      "Klorn//x.md",
      "Other/x.md",
      "Klorn/x.txt",
    ]) {
      expect(isVaultPath(path), path).toBe(false);
    }
  });

  it("refuses controls, wiki-link characters, hidden files and trailing dots", () => {
    for (const path of [
      "Klorn/a\u0000.md",
      "Klorn/a\nb.md",
      "Klorn/a|b.md",
      "Klorn/a#b.md",
      "Klorn/a^b.md",
      "Klorn/a[b].md",
      "Klorn/a:b.md",
      "Klorn/.hidden.md",
      "Klorn/dir./x.md",
      "Klorn/dir /x.md",
      "Klorn/a\u202Eb.md",
    ]) {
      expect(isVaultPath(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("refuses an over-long segment or path", () => {
    expect(isVaultPath(`Klorn/${"a".repeat(VAULT_MAX_SEGMENT_BYTES)}.md`)).toBe(false);
    const deep = `Klorn/${Array.from({ length: 40 }, () => "abcdefgh").join("/")}.md`;
    expect(Buffer.byteLength(deep)).toBeGreaterThan(VAULT_MAX_PATH_BYTES);
    expect(isVaultPath(deep)).toBe(false);
  });
});
