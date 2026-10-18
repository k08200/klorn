import { describe, expect, it } from "vitest";
import { renderableEmailHtml, stripPositioningStyles } from "../mail/email-text.js";

// renderableEmailHtml allowed the style attribute with no CSS filter, so a
// sender could pin a fake UI over the reader with position:fixed (the client
// webviews run without JS, but layout CSS still applies). Positioning is
// stripped; every other declaration is kept as the sender wrote it.

describe("stripPositioningStyles", () => {
  it("drops position and z-index and keeps the rest", () => {
    expect(stripPositioningStyles("position:fixed;top:0;color:red")).toBe("top:0;color:red");
    expect(stripPositioningStyles(" POSITION : Fixed ; z-index: 9999; margin:0")).toBe(" margin:0");
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
