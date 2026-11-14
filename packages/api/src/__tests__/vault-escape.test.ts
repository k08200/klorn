/**
 * Klorn Vault escaping (vault/vault-escape.ts). Mail text is untrusted: a
 * subject, snippet, reason or body must never become YAML structure, a
 * wiki-link, an embed, a tag, HTML, a comment or a frontmatter fence in the
 * user's Obsidian vault.
 */

import { describe, expect, it } from "vitest";
import { aliasText, codeBlock, mdInline, wikiLink, yamlString } from "../vault/vault-escape.js";

describe("yamlString", () => {
  it("double-quotes every value, so YAML syntax in mail text stays text", () => {
    expect(yamlString("plain")).toBe('"plain"');
    expect(yamlString("key: value # not a comment")).toBe('"key: value # not a comment"');
    expect(yamlString("- list\n- item")).toBe('"- list - item"');
    expect(yamlString("&anchor *alias !!python/object")).toBe('"&anchor *alias !!python/object"');
  });

  it("escapes quotes and backslashes, and keeps the value on one line", () => {
    expect(yamlString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
    expect(yamlString("a\r\nb\u2028c\u2029d\u0085e")).toBe('"a b c d e"');
  });

  it("cannot close the frontmatter: '---' inside a value is quoted on one line", () => {
    const out = yamlString("x\n---\nlane: PUSH");
    expect(out).toBe('"x --- lane: PUSH"');
    expect(out).not.toContain("\n");
  });

  it("drops controls, bidi overrides and zero-width characters", () => {
    expect(yamlString("ab\u202Ecd\u200Bef\u0007")).toBe('"abcdef"');
  });

  it("replaces lone surrogates and caps the length", () => {
    expect(yamlString("a\uD800b")).toBe('"a\uFFFDb"');
    expect(yamlString("x".repeat(50), 10)).toBe(`"${"x".repeat(9)}…"`);
  });

  it("is valid JSON, a subset of YAML 1.2 double-quoted scalars", () => {
    const tricky = 'He said: "[[evil]]" #tag\t%% ---';
    expect(JSON.parse(yamlString(tricky))).toBe('He said: "[[evil]]" #tag %% ---');
  });
});

describe("mdInline", () => {
  it("neutralizes wiki-links and embeds", () => {
    expect(mdInline("see [[Secret note]]")).toBe("see \\[\\[Secret note\\]\\]");
    expect(mdInline("![[image.png]]")).toBe("\\!\\[\\[image.png\\]\\]");
  });

  it("neutralizes markdown links, images, HTML and autolinks", () => {
    expect(mdInline("[click](https://x.test)")).toBe("\\[click\\](https://x.test)");
    expect(mdInline('<img src=x onerror="a">')).toBe('\\<img src\\=x onerror\\="a"\\>');
    expect(mdInline("<https://x.test>")).toBe("\\<https://x.test\\>");
  });

  it("neutralizes tags, comments, math, highlights, block ids and tables", () => {
    expect(mdInline("#urgent %%hidden%% $x$ ==hi== ^block a|b")).toBe(
      "\\#urgent \\%\\%hidden\\%\\% \\$x\\$ \\=\\=hi\\=\\= \\^block a\\|b",
    );
  });

  it("neutralizes emphasis, code and entities", () => {
    expect(mdInline("*b* _i_ ~~s~~ `c` &lt;")).toBe("\\*b\\* \\_i\\_ \\~\\~s\\~\\~ \\`c\\` \\&lt;");
  });

  it("neutralizes Dataview inline fields", () => {
    expect(mdInline("Status:: urgent")).toBe("Status:\\: urgent");
  });

  it("neutralizes a leading list, quote, heading or rule marker", () => {
    expect(mdInline("- item")).toBe("\\- item");
    expect(mdInline("+ item")).toBe("\\+ item");
    expect(mdInline("1. item")).toBe("1\\. item");
    expect(mdInline("12) item")).toBe("12\\) item");
    expect(mdInline("> quote")).toBe("\\> quote");
    expect(mdInline("# Heading")).toBe("\\# Heading");
    expect(mdInline("---")).toBe("\\---");
  });

  it("keeps the text on one line, so no line can start a block", () => {
    const out = mdInline("first\n---\n# second\r\n[[x]]");
    expect(out).not.toMatch(/\n/);
    expect(out).toBe("first --- \\# second \\[\\[x\\]\\]");
  });

  it("escapes a backslash first, so an attacker's escape cannot undo ours", () => {
    expect(mdInline("\\[[x]]")).toBe("\\\\\\[\\[x\\]\\]");
  });

  it("leaves ordinary text and non-Latin scripts alone", () => {
    expect(mdInline("내일 3시 회의 – 确认")).toBe("내일 3시 회의 – 确认");
  });

  it("caps the length after cleaning", () => {
    expect(mdInline("abcdef", 4)).toBe("abc…");
  });
});

describe("codeBlock", () => {
  it("fences the text with a fence longer than any backtick run inside it", () => {
    const out = codeBlock("a\n````\nb");
    expect(out).toBe("`````text\na\n````\nb\n`````");
  });

  it("uses a three-backtick fence for text without backticks", () => {
    expect(codeBlock("hello")).toBe("```text\nhello\n```");
  });

  it("keeps frontmatter fences, links and HTML inert inside the block", () => {
    const body = "---\nlane: SILENT\n---\n[[x]] <script>alert(1)</script> %%c%%";
    const out = codeBlock(body);
    expect(out.startsWith("```text\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
    expect(out).toContain(body);
  });

  it("normalizes newlines and drops controls and bidi marks but keeps tabs", () => {
    expect(codeBlock("a\r\nb\rc\u0000d\u202Ee\tf")).toBe("```text\na\nb\ncde\tf\n```");
  });
});

describe("wikiLink and aliasText", () => {
  it("builds [[path|alias]] from a vault path, without the .md extension", () => {
    expect(wikiLink("Klorn/senders/corp.com.md", "Corp")).toBe("[[Klorn/senders/corp.com|Corp]]");
  });

  it("strips the characters that would end the link or the alias", () => {
    expect(aliasText("a]]|[[b\\c")).toBe("abc");
    expect(aliasText("<script>x</script> `c` #tag ^id 50%% off")).toBe(
      "scriptx/script c tag id 50% off",
    );
    expect(wikiLink("Klorn/lanes/PUSH.md", "x]] [[evil")).toBe("[[Klorn/lanes/PUSH|x evil]]");
  });

  it("falls back when the alias is empty once cleaned", () => {
    expect(aliasText("[[]]", "(no subject)")).toBe("(no subject)");
  });

  it("refuses a target that is not a safe vault path", () => {
    expect(() => wikiLink("Klorn/a|b.md", "x")).toThrow();
    expect(() => wikiLink("../etc/passwd.md", "x")).toThrow();
    expect(() => wikiLink("Klorn/a]]b.md", "x")).toThrow();
  });
});

describe("wikiLink in a table cell", () => {
  it("escapes the alias pipe so the link does not split the cell", () => {
    expect(wikiLink("Klorn/lanes/PUSH.md", "PUSH", { inTable: true })).toBe(
      "[[Klorn/lanes/PUSH\\|PUSH]]",
    );
  });
});

describe("Templater markers (run from a file's raw text)", () => {
  const TEMPLATE = "<%* tp.system.exec('x') %> and <% tp.date.now() %>";

  it("never leave a raw `<%` or `%>` in a YAML value, which still parses back", () => {
    const out = yamlString(TEMPLATE);
    expect(out).not.toMatch(/<%|%>/);
    expect(JSON.parse(out)).toBe(TEMPLATE);
  });

  it("never leave a raw `<%` or `%>` in note text", () => {
    expect(mdInline(TEMPLATE)).not.toMatch(/<%|%>/);
  });

  it("never leave a raw `<%` or `%>` in a body block or an alias", () => {
    expect(codeBlock(TEMPLATE)).not.toMatch(/<%|%>/);
    expect(codeBlock(TEMPLATE)).toContain("<​%* tp.system.exec('x') %​>");
    expect(aliasText(TEMPLATE)).not.toMatch(/<%|%>/);
  });
});

describe("aliasText comment markers", () => {
  it("folds a `%%` hidden by a format character or created by stripping", () => {
    expect(aliasText("a%​%b")).toBe("a%b");
    expect(aliasText("a%[%b")).toBe("a%b");
    expect(aliasText("a%]]%%[[%b")).toBe("a%b");
  });
});
