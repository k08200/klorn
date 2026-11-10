// Pins the mobile reader's second wall (mail-html.ts) — the same cases the web
// copy is held to (packages/api/src/__tests__/web-mail-html.test.ts), plus the
// mobile-only pieces: dark frames and link handling.
import { describe, expect, it } from "vitest";
import {
  buildMailSrcdoc,
  cidRefs,
  countRemoteImages,
  frameTheme,
  hasAuthoredColors,
  mailLinkAction,
  neutralizeMailHtml,
} from "./mail-html";

const body = (doc: string) => doc.slice(doc.indexOf("<body>"));

describe("neutralizeMailHtml — XSS", () => {
  it("removes script and style blocks with their content", () => {
    const out = neutralizeMailHtml(
      "<p>a</p><script>alert(1)</script><SCRIPT src=x></SCRIPT><style>p{}</style>",
    );
    expect(out).toBe("<p>a</p>");
  });

  it("removes event-handler attributes in any quoting", () => {
    const out = neutralizeMailHtml(
      `<img src="data:image/png;base64,AA" onerror="alert(1)"><p onclick='x()' ONMOUSEOVER=y>t</p>`,
    );
    expect(out).not.toMatch(/onerror|onclick|onmouseover/i);
    expect(out).toContain("<p");
  });

  it("drops active and navigating elements", () => {
    const out = neutralizeMailHtml(
      '<iframe src="https://e.example"></iframe><object data="x"></object><embed src="x">' +
        '<form action="x"><input></form><meta http-equiv="refresh" content="0"><base href="https://e.example/">' +
        '<svg onload="x"><circle/></svg><math></math><link rel="x"><p>ok</p>',
    );
    expect(out).not.toMatch(/<(iframe|object|embed|form|input|meta|base|svg|circle|math|link)\b/i);
    expect(out).toContain("<p>ok</p>");
  });

  it("neutralises javascript:, vbscript: and non-image data: urls", () => {
    const out = neutralizeMailHtml(
      '<a href="javascript:alert(1)">a</a><a href=" JAVASCRIPT:x">b</a><a href="vbscript:x">c</a>' +
        '<a href="data:text/html,x">d</a><img src="data:image/svg+xml,<svg>">',
    );
    expect(out).not.toMatch(/javascript:|vbscript:|data:text|svg\+xml/i);
  });

  it("keeps https links, mailto and raster data: images", () => {
    const out = neutralizeMailHtml(
      '<a href="https://ok.example/a">a</a><a href="mailto:x@y.example">m</a><img src="data:image/png;base64,AA">',
    );
    expect(out).toContain('href="https://ok.example/a"');
    expect(out).toContain('href="mailto:x@y.example"');
    expect(out).toContain('src="data:image/png;base64,AA"');
  });

  it("strips CSS expression() and javascript: inside style attributes", () => {
    const out = neutralizeMailHtml(
      `<div style="width:expression(alert(1));color:red">a</div><p style="background:url(javascript:x)">b</p>`,
    );
    expect(out).not.toMatch(/expression\(|javascript:/i);
  });

  it("does not reassemble a script from split fragments", () => {
    const out = neutralizeMailHtml("<scr<script>x</script>ipt>alert(1)</script>");
    expect(out).not.toMatch(/<script/i);
  });

  it("keeps an unterminated or quote-broken tag as inert text", () => {
    const out = neutralizeMailHtml('<p>a</p><img src=x title="unclosed onerror=alert(1)><b>b</b>');
    expect(out).not.toMatch(/<img[^>]*onerror/i);
    expect(out).toContain("&lt;img");
    expect(out).toContain("&lt;b&gt;b&lt;/b&gt;");
  });

  it("decodes entity-obfuscated schemes before checking them", () => {
    const out = neutralizeMailHtml(
      '<a href="&#106;avascript:alert(1)">a</a><a href="java&#x0A;script:x">b</a>',
    );
    expect(out).not.toMatch(/href=/i);
  });

  it("re-quotes attributes so a value can never break out into a new attribute", () => {
    const out = neutralizeMailHtml(`<p title='a" onmouseover="alert(1)'>x</p>`);
    expect(out).toBe('<p title="a&quot; onmouseover=&quot;alert(1)">x</p>');
  });

  it("escapes text so an encoded tag stays text", () => {
    expect(neutralizeMailHtml("&lt;script&gt;alert(1)&lt;/script&gt;")).not.toMatch(/<script/i);
    expect(neutralizeMailHtml("a < b > c")).toBe("a &lt; b &gt; c");
  });

  it("drops comments and conditional comments wholesale", () => {
    const out = neutralizeMailHtml("<!--[if IE]><script>x</script><![endif]--><p>ok</p>");
    expect(out).toBe("<p>ok</p>");
  });

  it("survives out-of-range numeric entities instead of throwing", () => {
    expect(() =>
      neutralizeMailHtml('<a href="&#x110000;https://a.example" title="&#99999999999;">a</a>'),
    ).not.toThrow();
    expect(neutralizeMailHtml('<p title="&#x110000;">x</p>')).toBe('<p title="�">x</p>');
  });

  it("maps zero and surrogate numeric entities to U+FFFD, as the HTML tokenizer does", () => {
    for (const ref of ["&#0;", "&#x0;", "&#xD800;", "&#xDFFF;", "&#56320;"]) {
      const out = neutralizeMailHtml(`<p title="a${ref}b">x</p>`);
      expect(out).toBe('<p title="a�b">x</p>');
    }
  });

  it.each([
    ["image-set", 'background-image:image-set("https://t.example/a.png" 1x)'],
    ["escaped url", "background:u\\72l(https://t.example/a.png)"],
  ])("drops a style using %s even with images allowed", (_label, style) => {
    const out = neutralizeMailHtml(`<div style='${style}'>x</div>`, { allowRemoteImages: true });
    expect(out).toBe("<div>x</div>");
  });

  it("is linear on hostile input", () => {
    for (const unit of ["<a ", '<script a="', "<!--", "<p style='url(url("]) {
      const input = unit.repeat(Math.ceil(200_000 / unit.length));
      const started = performance.now();
      buildMailSrcdoc(input, { allowRemoteImages: false });
      countRemoteImages(input);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});

describe("remote images", () => {
  const html =
    '<p>Hi</p><img src="https://t.example/pixel.gif" alt="px"><a href="https://ok.example">go</a>';

  it("counts http(s) img srcs and css url() loads, not data:/cid:", () => {
    expect(
      countRemoteImages(
        '<img src="https://t.example/p.gif"><img src="http://t.example/q.png"><img src="data:image/png;base64,AA">' +
          '<img src="cid:logo"><td style="background-image:url(\'https://t.example/bg.png\')">x</td>',
      ),
    ).toBe(3);
  });

  it("blocks them by default: CSP img-src data: only and srcs removed", () => {
    const doc = buildMailSrcdoc(html, { allowRemoteImages: false });
    expect(doc).toMatch(/img-src data:;/);
    expect(body(doc)).not.toContain("https://t.example/pixel.gif");
    expect(body(doc)).toContain('alt="px"');
  });

  it("blocks css url() loads while images are blocked", () => {
    const doc = buildMailSrcdoc(
      '<td style="background:url(https://t.example/bg.png) #fff">x</td>',
      {
        allowRemoteImages: false,
      },
    );
    expect(body(doc)).not.toContain("t.example");
  });

  it("lets them through once the reader allows them", () => {
    const doc = buildMailSrcdoc(html, { allowRemoteImages: true });
    expect(doc).toMatch(/img-src data: https: http:;/);
    expect(body(doc)).toContain('src="https://t.example/pixel.gif"');
  });

  it("swaps resolved cid: images for data urls and drops the rest", () => {
    const doc = buildMailSrcdoc('<img src="cid:logo@x" alt="l"><img src="cid:missing" alt="m">', {
      allowRemoteImages: false,
      inlineImages: { "logo@x": "data:image/png;base64,AAAA", missing: "https://t.example/x" },
    });
    expect(body(doc)).toContain('src="data:image/png;base64,AAAA"');
    expect(body(doc)).not.toMatch(/cid:|t\.example/);
  });

  it("lists distinct cid references without dot segments", () => {
    expect(cidRefs('<img src="cid:.."><img src="CID:a"><img src="cid:a">')).toEqual(["a"]);
  });
});

describe("buildMailSrcdoc", () => {
  it("puts a script-free CSP meta first in head", () => {
    const doc = buildMailSrcdoc("<p>x</p>", { allowRemoteImages: false });
    const csp = doc.indexOf('http-equiv="Content-Security-Policy"');
    expect(csp).toBeGreaterThan(doc.indexOf("<head>"));
    expect(csp).toBeLessThan(doc.indexOf("<body>"));
    expect(doc).toMatch(/default-src 'none'/);
    expect(doc).toMatch(/form-action 'none'/);
    expect(doc).not.toMatch(/script-src|<script/);
  });

  it("never lets a sender <base> in, and links carry noopener noreferrer", () => {
    const doc = buildMailSrcdoc(
      '<base href="https://evil.example/"><a href="https://a.example" target="_top" rel="opener">a</a>',
      { allowRemoteImages: false },
    );
    expect(doc).not.toMatch(/<base|evil\.example|target=|rel="opener"/);
    expect(body(doc)).toContain('rel="noopener noreferrer"');
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("neutralises script and handlers even if the server wall were bypassed", () => {
    const doc = buildMailSrcdoc("<script>alert(1)</script><img src=x onerror=alert(1)>", {
      allowRemoteImages: true,
    });
    expect(doc).not.toMatch(/<script|onerror/i);
  });

  it("draws a light sheet unless asked for the dark surface", () => {
    expect(buildMailSrcdoc("<p>x</p>", { allowRemoteImages: false })).toContain(
      "color-scheme:light",
    );
    expect(buildMailSrcdoc("<p>x</p>", { allowRemoteImages: false, theme: "dark" })).toContain(
      "color-scheme:dark",
    );
  });
});

describe("dark mode", () => {
  it("keeps the light sheet for mail that paints its own colours", () => {
    expect(hasAuthoredColors('<table bgcolor="#fff"><tr><td>x</td></tr></table>')).toBe(true);
    expect(hasAuthoredColors('<font color="red">x</font>')).toBe(true);
    expect(hasAuthoredColors('<div style="font-size:14px; color: #333">x</div>')).toBe(true);
    expect(hasAuthoredColors('<td style="background-color:#eee">x</td>')).toBe(true);
    expect(frameTheme('<p style="color:#111">x</p>', true)).toBe("light");
  });

  it("uses the dark surface for plain-styled mail in dark mode only", () => {
    const plain = '<p style="margin:0;font-size:15px">Hi</p><a href="https://a.example">a</a>';
    expect(hasAuthoredColors(plain)).toBe(false);
    expect(frameTheme(plain, true)).toBe("dark");
    expect(frameTheme(plain, false)).toBe("light");
  });
});

describe("mailLinkAction", () => {
  it("opens https in the system browser and upgrades http", () => {
    expect(mailLinkAction("https://a.example/x?y=1")).toEqual({
      kind: "browser",
      url: "https://a.example/x?y=1",
    });
    expect(mailLinkAction("http://a.example/")).toEqual({
      kind: "browser",
      url: "https://a.example/",
    });
  });

  it("turns mailto into a compose target", () => {
    expect(mailLinkAction("mailto:Kim%20<x@y.example>")).toBeNull();
    expect(mailLinkAction("mailto:x@y.example?subject=hi")).toEqual({
      kind: "mailto",
      address: "x@y.example",
    });
    expect(mailLinkAction("mailto:%E0%A4%A")).toBeNull();
  });

  it("refuses every other scheme", () => {
    for (const href of [
      "javascript:alert(1)",
      " jav\tascript:alert(1)",
      "intent://x#Intent;end",
      "file:///etc/passwd",
      "data:text/html,x",
      "ai.klorn.app://oauth-callback?code=x",
      "",
      null,
    ]) {
      expect(mailLinkAction(href), String(href)).toBeNull();
    }
  });
});
