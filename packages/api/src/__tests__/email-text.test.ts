import { describe, expect, it } from "vitest";
import { htmlToPlainText } from "../email-text.js";

// HTML-only emails used to persist body=null and fall out of the summarizer
// forever ("Klorn has not analyzed this email yet"). htmlToPlainText is the
// rescue: a safe, sanitize-html-based text projection that keeps link hrefs
// (verification links live in href, not anchor text).

describe("htmlToPlainText", () => {
  it("strips tags to plain text", () => {
    expect(htmlToPlainText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("keeps http(s) link targets so verification URLs survive", () => {
    const html = '<p>Confirm your email by <a href="https://huggingface.co/email_confirmation/abc">clicking here</a></p>';
    const text = htmlToPlainText(html);
    expect(text).toContain("https://huggingface.co/email_confirmation/abc");
  });

  it("drops javascript: and data: link targets", () => {
    const text = htmlToPlainText('<a href="javascript:alert(1)">x</a><a href="data:text/html,hi">y</a>');
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("data:");
  });

  it("preserves line structure for paragraphs and breaks", () => {
    const text = htmlToPlainText("<p>one</p><p>two</p>line<br>break");
    expect(text).toMatch(/one\s*\n+\s*two/);
    expect(text).toMatch(/line\s*\n\s*break/);
  });

  it("decodes common entities", () => {
    expect(htmlToPlainText("<p>a &amp; b &lt;c&gt;&nbsp;d</p>")).toBe("a & b <c> d");
  });

  it("never emits markup even from hostile input", () => {
    const text = htmlToPlainText('<img src=x onerror=alert(1)><script>alert(2)</script>ok');
    expect(text).not.toContain("<");
    expect(text).toContain("ok");
  });

  it("returns empty string for empty/blank html", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText("   ")).toBe("");
  });
});
