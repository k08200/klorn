import { describe, expect, it } from "vitest";
import { coercePlainBody, htmlToPlainText } from "../mail/email-text.js";

// HTML-only emails used to persist body=null and fall out of the summarizer
// forever ("Klorn has not analyzed this email yet"). htmlToPlainText is the
// rescue: a safe, sanitize-html-based text projection that keeps link hrefs
// (verification links live in href, not anchor text).

describe("htmlToPlainText", () => {
  it("strips tags to plain text", () => {
    expect(htmlToPlainText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("keeps http(s) link targets so verification URLs survive", () => {
    const html =
      '<p>Confirm your email by <a href="https://huggingface.co/email_confirmation/abc">clicking here</a></p>';
    const text = htmlToPlainText(html);
    expect(text).toContain("https://huggingface.co/email_confirmation/abc");
  });

  it("drops javascript: and data: link targets", () => {
    const text = htmlToPlainText(
      '<a href="javascript:alert(1)">x</a><a href="data:text/html,hi">y</a>',
    );
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
    const text = htmlToPlainText("<img src=x onerror=alert(1)><script>alert(2)</script>ok");
    expect(text).not.toContain("<");
    expect(text).toContain("ok");
  });

  it("returns empty string for empty/blank html", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText("   ")).toBe("");
  });
});

describe("coercePlainBody", () => {
  const PADDLE_LIKE_PLAIN = `<tr width="100%">
  <td width="100%" align="center" style="padding:0">
    <table style="max-width:600px;border-collapse:collapse" width="100%"><tbody>
      <tr><td style="padding:0">
        <h2 style="font-family:Graphik,Helvetica,sans-serif">Verify your identity</h2>
        <p style="font-size:16px">You&#39;re one step away from taking live payments.</p>
        <a href="https://in.sumsub.com/websdk/p/abc123" style="color:#fff">Verify my identity</a>
      </td></tr>
    </tbody></table>
  </td>
</tr>`;

  it("keeps genuine plain text untouched", () => {
    const body = "Hi,\n\nplease review the attached invoice.\n\nThanks";
    expect(coercePlainBody(body, "<p>Hi</p>")).toBe(body);
  });

  it("keeps prose that merely mentions a tag or two", () => {
    const body = "Use a <div> wrapper and close it with </div> when embedding.";
    expect(coercePlainBody(body, null)).toBe(body);
  });

  it("projects the html part when the plain part is raw html (Paddle 2026-08-13)", () => {
    const html = "<p>Hi yongrean,</p><p>You&#39;re one step away from taking live payments.</p>";
    const out = coercePlainBody(PADDLE_LIKE_PLAIN, html);
    expect(out).not.toContain("<td");
    expect(out).not.toContain("style=");
    expect(out).toContain("one step away from taking live payments");
  });

  it("strips the plain part itself when it is raw html and no html part exists", () => {
    const out = coercePlainBody(PADDLE_LIKE_PLAIN, null);
    expect(out).not.toContain("<td");
    expect(out).toContain("Verify your identity");
    // anchor href surfaced as text, like every other projection
    expect(out).toContain("https://in.sumsub.com/websdk/p/abc123");
  });

  it("passes null/empty through", () => {
    expect(coercePlainBody(null, "<p>x</p>")).toBeNull();
    expect(coercePlainBody("", "<p>x</p>")).toBe("");
  });
});

describe("renderableEmailHtml — sanitized HTML for real mail rendering", () => {
  it("keeps the structural/layout markup email actually uses", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const html = `<table width="600"><tr><td style="padding:16px;color:#333">
      <h1 style="font-size:20px">Hello</h1>
      <p>Body <strong>bold</strong> <a href="https://example.com/verify">verify</a></p>
      <img src="https://cdn.example.com/logo.png" alt="logo" width="120">
    </td></tr></table>`;
    const out = renderableEmailHtml(html);
    expect(out).toContain("<table");
    expect(out).toContain("<td");
    expect(out).toContain('href="https://example.com/verify"');
    expect(out).toContain('src="https://cdn.example.com/logo.png"');
    expect(out).toContain("padding:16px");
  });

  it("strips scripts, event handlers, javascript: urls and iframes", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const out = renderableEmailHtml(`<p onclick="steal()">x</p>
      <script>alert(1)</script>
      <iframe src="https://evil.example"></iframe>
      <a href="javascript:alert(1)">click</a>
      <img src="x" onerror="alert(1)">`);
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("javascript:");
  });

  it("allows data: images but not data: links", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const out = renderableEmailHtml(
      '<img src="data:image/png;base64,AAAA"><a href="data:text/html,x">a</a>',
    );
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).not.toContain('href="data:');
  });

  it("returns null for empty/whitespace input", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    expect(renderableEmailHtml(null)).toBeNull();
    expect(renderableEmailHtml("   ")).toBeNull();
  });
});

describe("renderableEmailHtmlFor — render-source selection", () => {
  it("prefers the html part, falls back to a raw-html plain part, else null", async () => {
    const { renderableEmailHtmlFor } = await import("../mail/email-text.js");
    expect(renderableEmailHtmlFor("plain text", "<p>rich</p>")).toContain("<p>rich</p>");
    const rawHtmlPlain =
      '<table><tr><td style="padding:8px"><a href="https://x.example/verify">Verify</a></td></tr></table>' +
      '<div style="color:#333"><p>hello</p><p>world</p></div>';
    expect(renderableEmailHtmlFor(rawHtmlPlain, null)).toContain("<td");
    expect(renderableEmailHtmlFor("just words, no markup", null)).toBeNull();
  });
});

describe("renderableEmailHtml — cid: images", () => {
  it("keeps cid: images (resolved by the client scheme handler) and drops src-less shells", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const out = renderableEmailHtml(
      '<p>Logo:</p><img src="cid:logo@mail" alt="Logo"><img alt="shell"><img src="https://x.example/a.png" alt="ok">',
    );
    expect(out).toContain('src="cid:logo@mail"');
    expect(out).not.toContain('alt="shell"');
    expect(out).toContain('src="https://x.example/a.png"');
  });
});

// Web reader matrix (2026-10-16): the web renders renderHtml in a sandboxed
// iframe; these pin the first wall against the classic payloads.
describe("renderableEmailHtml — hostile markup matrix", () => {
  it("drops svg (and its script/onload) entirely", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const out = renderableEmailHtml(
      '<p>a</p><svg onload="alert(1)"><script>alert(2)</script><a xlink:href="javascript:alert(3)">x</a></svg>',
    );
    expect(out).not.toMatch(/svg|onload|script|javascript:/i);
  });

  it("drops forms, inputs, object, embed, meta refresh, base, link and style blocks", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const out = renderableEmailHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">' +
        '<link rel="stylesheet" href="https://evil.example/a.css"><style>body{background:url(https://t.example/p)}</style>' +
        '<form action="https://evil.example"><input name="pw"><button>go</button></form>' +
        '<object data="https://evil.example/x"></object><embed src="https://evil.example/y"><p>kept</p>',
    );
    expect(out).toContain("<p>kept</p>");
    expect(out).not.toMatch(/<meta|<base|<link|<style|<form|<input|<button|<object|<embed/i);
    expect(out).not.toContain("evil.example");
  });

  it("strips obfuscated javascript: hrefs and vbscript:", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const out = renderableEmailHtml(
      '<a href="  JaVaScRiPt:alert(1)">a</a><a href="java&#x09;script:alert(1)">b</a><a href="vbscript:x">c</a>',
    );
    expect(out).not.toMatch(/javascript|vbscript|href=/i);
  });

  it("keeps raster data: images but drops svg and non-image data: srcs", async () => {
    const { renderableEmailHtml } = await import("../mail/email-text.js");
    const out = renderableEmailHtml(
      '<img src="data:image/gif;base64,R0lG" alt="g">' +
        '<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="s">' +
        '<img src="data:text/html;base64,PHNjcmlwdD4=" alt="h">',
    );
    expect(out).toContain('src="data:image/gif;base64,R0lG"');
    expect(out).not.toContain("svg+xml");
    expect(out).not.toContain("text/html");
  });
});
