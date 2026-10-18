import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { renderableEmailHtml, stripPositioningStyles } from "../mail/email-text.js";

// renderableEmailHtml allowed the style attribute with no CSS filter, so a
// sender could pin a fake UI over the reader with position:fixed (the client
// webviews run without JS, but layout CSS still applies). Positioning is
// stripped; every other declaration is kept as the sender wrote it.

/**
 * The properties a style really declares. With no line break left in it,
 * postcss and a browser tokenize a style alike, so this is a faithful oracle;
 * a string value that merely contains the word "position" declares nothing.
 */
function declaredProperties(style: string): string[] {
  expect(style).not.toMatch(/[\r\n\f]/);
  const props: string[] = [];
  postcss.parse(`a{${style}}`).walkDecls((decl) => {
    props.push(decl.prop.toLowerCase());
  });
  return props;
}

function styleOf(html: string): string {
  const raw = /style="([^"]*)"/.exec(html)?.[1] ?? "";
  return raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

describe("stripPositioningStyles", () => {
  it("drops position and z-index and keeps the rest", () => {
    expect(stripPositioningStyles("position:fixed;top:0;color:red")).toBe("top:0;color:red");
    expect(stripPositioningStyles(" POSITION : Fixed ; z-index: 9999; margin:0")).toBe("margin:0");
  });

  it("drops a declaration whose property name is not a plain CSS identifier", () => {
    // CSS escapes and comments can spell "position" without the word.
    expect(stripPositioningStyles("\\70 osition:fixed;color:red")).toBe("color:red");
    expect(stripPositioningStyles("position/**/:fixed;color:red")).toBe("color:red");
    expect(stripPositioningStyles("pos\\ition:fixed;color:red")).toBe("color:red");
  });

  it("keeps a data URL whose semicolon is not a declaration break", () => {
    const style = "background-image:url(data:image/png;base64,iVBORw0KGgo=);color:red";
    expect(stripPositioningStyles(style)).toBe(style);
  });

  it("is linear on a hostile attribute", () => {
    const hostile = `${";".repeat(200_000)}position:fixed${":".repeat(200_000)}`;
    const start = performance.now();
    stripPositioningStyles(hostile);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("stripPositioningStyles reads CSS the way the sanitizer re-emits it", () => {
  // The first filter split on a bare ";", while sanitize-html re-parses the
  // style with postcss (comments, strings and parens respected): these all came
  // back out as position:fixed / z-index (security review, 2026-10-17).
  it.each([
    "position/*;a:*/:fixed",
    '"x;a:"position:fixed',
    "'x;a:'position:fixed",
    "(x;a:)position:fixed",
    "z-index/*;a:*/:9999",
    "\\70 osition/*;a:*/:fixed",
    '"\\70 osition);a:"\\70 osition :fixed',
    "color:red;position/*;a:*/:fixed;top:0;left:0;width:100%;height:100%;background:#fff",
  ])("%s keeps no positioning through the renderer", (style) => {
    const out = renderableEmailHtml(`<div style='${style.replaceAll("'", "&#39;")}'>x</div>`) ?? "";
    expect(out.toLowerCase()).not.toMatch(/position|z-index|\\70/);
  });

  it.each([
    'a:"x\n;position:fixed;y"',
    "a:'x\n;position:fixed;y'",
    'a:"x\r;position:fixed;y"',
    'a:"x\f;position:fixed;y"',
    'a:"x\r\n;z-index:9999;y"',
    'font-family:"Arial\n;position:fixed;top:0;left:0;width:100%;height:100%;background:#fff;"',
  ])("a line break inside a string cannot smuggle a declaration: %j", (style) => {
    // postcss lets a string span lines; a browser ends it at the line break and
    // reads the rest as declarations (re-review, 2026-10-17).
    const props = declaredProperties(stripPositioningStyles(style));
    expect(props).not.toContain("position");
    expect(props).not.toContain("z-index");
  });

  it("does the same for an entity-encoded line break through the renderer", () => {
    const out =
      renderableEmailHtml('<div style="a:&quot;x&#10;;position:fixed;y&quot;">x</div>') ?? "";
    expect(declaredProperties(styleOf(out))).not.toContain("position");
  });

  it("drops an oversized style before parsing it (postcss is quadratic on one giant declaration)", () => {
    const hostile = "a/*;*/:".repeat(60_000);
    const start = performance.now();
    expect(stripPositioningStyles(hostile)).toBe("");
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("keeps a custom property's case, which var() references depend on", () => {
    expect(stripPositioningStyles("--Brand:#0af;color:var(--Brand)")).toBe(
      "--Brand:#0af;color:var(--Brand)",
    );
  });

  it("drops a style the CSS parser cannot read", () => {
    expect(stripPositioningStyles("color:red; } b { position:fixed")).not.toMatch(/position/);
  });
});

describe("renderableEmailHtml strips positioning from every tag", () => {
  it("cannot pin content over the reader", async () => {
    const html =
      '<div style="position:fixed;inset:0;z-index:99;background:#fff;color:#222">Your session expired</div>' +
      '<td style="POSITION:absolute;padding:4px">cell</td><img src="https://x.example/a.png" style="position:sticky;width:10px">';
    const out = renderableEmailHtml(html) ?? "";

    expect(out.toLowerCase()).not.toContain("position");
    expect(out.toLowerCase()).not.toContain("z-index");
    expect(out).toContain("background:#fff");
    expect(out).toContain("padding:4px");
    expect(out).toContain("width:10px");
  });
});
