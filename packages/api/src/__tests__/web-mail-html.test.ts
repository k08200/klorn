// Pins packages/web/src/lib/mail-html.ts — the web reader's second wall
// around the server-sanitized renderHtml before it becomes an iframe srcdoc.
// The web package has no unit runner, so its pure helper is exercised here.
import { describe, expect, it } from "vitest";
import {
  buildMailSrcdoc,
  cidRefs,
  countRemoteImages,
  estimateMailFrameHeight,
  MAIL_FRAME_MAX_HEIGHT,
  MAIL_FRAME_MIN_HEIGHT,
  neutralizeMailHtml,
} from "../../../web/src/lib/mail-html";

const body = (doc: string) => doc.slice(doc.indexOf("<body>"));

describe("neutralizeMailHtml — belt-and-braces strip", () => {
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
});

describe("neutralizeMailHtml — parser confusion", () => {
  it("does not reassemble a script from split fragments", () => {
    const out = neutralizeMailHtml("<scr<script>x</script>ipt>alert(1)</script>");
    expect(out).not.toMatch(/<script/i);
  });

  it("keeps an unterminated or quote-broken tag as inert text", () => {
    const out = neutralizeMailHtml('<p>a</p><img src=x title="unclosed onerror=alert(1)><b>b</b>');
    expect(out).not.toMatch(/<img[^>]*onerror/i);
    expect(out).toContain("&lt;img");
    expect(out).toContain("<b>b</b>");
  });

  it("survives out-of-range numeric entities instead of throwing", () => {
    expect(() =>
      neutralizeMailHtml('<a href="&#x110000;https://a.example" title="&#99999999999;">a</a>'),
    ).not.toThrow();
    expect(neutralizeMailHtml('<p title="&#x110000;">x</p>')).toContain("\ufffd");
  });

  it("emits a duplicated attribute once, keeping the first like the browser", () => {
    const out = neutralizeMailHtml(
      '<p style="color:red" style="background:url(https://t.example/x)">x</p>',
    );
    expect(out).toBe('<p style="color:red">x</p>');
  });

  it("decodes entity-obfuscated schemes before checking them", () => {
    const out = neutralizeMailHtml(
      '<a href="&#106;avascript:alert(1)">a</a><a href="java&#x0A;script:x">b</a>',
    );
    expect(out).not.toMatch(/href=/i);
  });
});

describe("countRemoteImages", () => {
  it("counts http(s) img srcs and css url() loads, not data:/cid:", () => {
    const html =
      '<img src="https://t.example/p.gif"><img src="http://t.example/q.png"><img src="data:image/png;base64,AA">' +
      '<img src="cid:logo"><td style="background-image:url(\'https://t.example/bg.png\')">x</td>';
    expect(countRemoteImages(html)).toBe(3);
  });

  it("ignores protocol-relative urls, which never load inside srcdoc", () => {
    expect(countRemoteImages('<img src="//t.example/p.gif">')).toBe(0);
  });

  it("is zero for plain text-ish html", () => {
    expect(countRemoteImages("<p>hello https://x.example</p>")).toBe(0);
  });
});

describe("buildMailSrcdoc", () => {
  const html =
    '<p>Hi</p><img src="https://t.example/pixel.gif" alt="px"><a href="https://ok.example">go</a>';

  it("puts the CSP meta first in head, before any sender content", () => {
    const doc = buildMailSrcdoc(html, { allowRemoteImages: false });
    const csp = doc.indexOf('http-equiv="Content-Security-Policy"');
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(doc.indexOf("<body>"));
    expect(doc.indexOf("<head>")).toBeLessThan(csp);
    expect(doc).toMatch(/default-src 'none'/);
    expect(doc).toMatch(/form-action 'none'/);
    expect(doc).not.toMatch(/script-src/);
  });

  it("blocks remote images by default: CSP img-src data: only and srcs removed", () => {
    const doc = buildMailSrcdoc(html, { allowRemoteImages: false });
    expect(doc).toMatch(/img-src data:;/);
    expect(body(doc)).not.toContain("https://t.example/pixel.gif");
    expect(body(doc)).toContain('alt="px"');
  });

  it("blocks css url() remote loads while images are blocked", () => {
    const doc = buildMailSrcdoc(
      '<td style="background:url(https://t.example/bg.png) #fff">x</td>',
      {
        allowRemoteImages: false,
      },
    );
    expect(body(doc)).not.toContain("t.example");
  });

  it("lets remote images through once allowed", () => {
    const doc = buildMailSrcdoc(html, { allowRemoteImages: true });
    expect(doc).toMatch(/img-src data: https: http:;/);
    expect(body(doc)).toContain('src="https://t.example/pixel.gif"');
  });

  it("injects exactly one base target=_blank after sanitising, so a sender base cannot win", () => {
    const doc = buildMailSrcdoc(
      '<base href="https://evil.example/" target="_self"><a href="https://ok.example">x</a>',
      {
        allowRemoteImages: false,
      },
    );
    expect(doc.match(/<base\b/gi)).toHaveLength(1);
    expect(doc).toContain('<base target="_blank">');
    expect(doc).not.toContain("evil.example");
    expect(doc.indexOf("<base")).toBeLessThan(doc.indexOf("<body>"));
  });

  it("marks every link noopener noreferrer and sets a no-referrer policy", () => {
    const doc = buildMailSrcdoc(
      '<a href="https://a.example">a</a><a title="t" href="https://b.example">b</a>',
      {
        allowRemoteImages: false,
      },
    );
    expect(body(doc).match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("drops any rel/target the sender set, so ours is the only one", () => {
    const doc = buildMailSrcdoc('<a href="https://a.example" target="_top" rel="opener">a</a>', {
      allowRemoteImages: false,
    });
    expect(body(doc)).not.toMatch(/target=|rel="opener"/);
  });

  it("renders on a light page whatever the app theme", () => {
    const doc = buildMailSrcdoc("<p>x</p>", { allowRemoteImages: false });
    expect(doc).toContain("color-scheme: light");
  });

  it("swaps resolved cid: images for their data urls and drops unresolved ones", () => {
    const doc = buildMailSrcdoc('<img src="cid:logo@x" alt="l"><img src="cid:missing" alt="m">', {
      allowRemoteImages: false,
      inlineImages: { "logo@x": "data:image/png;base64,AAAA" },
    });
    expect(body(doc)).toContain('src="data:image/png;base64,AAAA"');
    expect(body(doc)).not.toContain("cid:");
  });

  it("ignores inline image values that are not raster data urls", () => {
    const doc = buildMailSrcdoc('<img src="cid:a" alt="a">', {
      allowRemoteImages: false,
      inlineImages: { a: "https://t.example/x.png" },
    });
    expect(body(doc)).not.toContain("t.example");
  });

  it("neutralises script and handlers even if the server wall were bypassed", () => {
    const doc = buildMailSrcdoc("<script>alert(1)</script><img src=x onerror=alert(1)>", {
      allowRemoteImages: true,
    });
    expect(doc).not.toMatch(/<script|onerror/i);
  });
});

describe("cidRefs", () => {
  it("matches the scheme case-insensitively", () => {
    expect(cidRefs('<img src="CID:Logo@x">')).toEqual(["Logo@x"]);
  });

  it("lists distinct cid references, capped", () => {
    expect(cidRefs('<img src="cid:a"><img src="cid:b"><img src="cid:a">')).toEqual(["a", "b"]);
    const many = Array.from({ length: 30 }, (_, i) => `<img src="cid:c${i}">`).join("");
    expect(cidRefs(many)).toHaveLength(10);
  });
});

describe("estimateMailFrameHeight", () => {
  it("stays within the bounds", () => {
    expect(estimateMailFrameHeight("<p>hi</p>")).toBe(MAIL_FRAME_MIN_HEIGHT);
    expect(estimateMailFrameHeight(`<p>${"word ".repeat(20000)}</p>`)).toBe(MAIL_FRAME_MAX_HEIGHT);
  });

  it("grows with content", () => {
    const short = estimateMailFrameHeight(`<p>${"word ".repeat(200)}</p>`);
    const long = estimateMailFrameHeight(`<p>${"word ".repeat(600)}</p><img src="x" height="300">`);
    expect(long).toBeGreaterThan(short);
  });
});
