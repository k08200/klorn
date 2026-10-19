/**
 * Google Play's two required graphics, rendered from the same mock build as the
 * store screenshots (playwright.store.config.ts):
 *
 *   play/feature-graphic-{en,ko}.jpg — 1024 × 500, JPEG (Play: JPEG or 24-bit
 *     PNG, no alpha). The listing's subtitle next to the app's real Today
 *     screen, in Klorn's tokens.
 *   play/icon-512.png — 512 × 512 32-bit PNG from assets/icon-only.png.
 *
 * Output goes next to the screenshots: test-results/store-shots/play/
 * (or $KLORN_STORE_SHOTS_DIR/play/).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { openApp, settle } from "../../e2e/helpers";

const OUT = process.env.KLORN_STORE_SHOTS_DIR ?? `${process.cwd()}/test-results/store-shots`;
const ICON = fileURLToPath(new URL("../../assets/icon-only.png", import.meta.url));

/** store-pack/metadata.md — App Store subtitle and Play short description. */
const COPY = {
  en: {
    tag: "en-US",
    title: "All your mail,<br>one calm place",
    body: "Your mail and calendars in one calm list, sorted into five lanes with reasons.",
  },
  ko: {
    tag: "ko-KR",
    title: "모든 메일과 캘린더를,<br>한 곳에서",
    body: "흩어진 메일과 캘린더를 한 목록에. 다섯 레인으로 나누고, 왜 그런지 알려 줍니다.",
  },
} as const;

const LANES = [
  ["PUSH", "#9f1239"],
  ["MEETING", "#4338ca"],
  ["QUEUE", "#92400e"],
  ["INFO", "#155e75"],
  ["SILENT", "#57534e"],
] as const;

for (const [short, copy] of Object.entries(COPY)) {
  test(`feature graphic · ${short}`, async ({ browser }) => {
    // 1. The real Today screen, phone-sized, for the device on the right.
    const phone = await browser.newPage({
      viewport: { width: 360, height: 740 },
      deviceScaleFactor: 2,
      locale: copy.tag,
    });
    await openApp(phone, "/today", { theme: "light", insets: "24,0,16,0" });
    await settle(phone);
    const shot = (await phone.screenshot()).toString("base64");
    await phone.close();

    // 2. The graphic, on the app's own origin so its fonts (tokens.css) load.
    const page = await browser.newPage({
      viewport: { width: 1024, height: 500 },
      deviceScaleFactor: 1,
      locale: copy.tag,
    });
    await openApp(page, "/today", { theme: "light" });
    await settle(page);
    const chips = LANES.map(
      ([name, ink]) =>
        `<span class="chip"><i style="background:${ink}"></i><b style="color:${ink}">${name}</b></span>`,
    ).join("");
    await page.evaluate(
      ({ title, body, chips, shot }) => {
        document.head.insertAdjacentHTML(
          "beforeend",
          `<style>
            html, body { margin: 0; width: 1024px; height: 500px; overflow: hidden; }
            #fg { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center;
              gap: 56px; padding: 0 64px 0 72px; box-sizing: border-box; overflow: hidden;
              background: radial-gradient(120% 140% at 85% 30%, #e0f2fe 0%, #f8fafc 46%, #fafafa 100%);
              font-family: var(--font-sans, "Geist"), "Noto Sans KR", sans-serif; color: #0f172a;
              -webkit-font-smoothing: antialiased; }
            #fg .text { flex: 1 1 auto; display: flex; flex-direction: column; gap: 18px; }
            #fg .brand { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; color: #0369a1; }
            #fg h1 { margin: 0; font-size: 46px; line-height: 1.12; font-weight: 700; letter-spacing: -0.025em; }
            #fg p { margin: 0; max-width: 460px; font-size: 19px; line-height: 1.45; color: #475569; }
            #fg .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
            #fg .chip { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px;
              border-radius: 15px; background: #fff; border: 1px solid rgba(15,23,42,.08);
              box-shadow: 0 1px 2px rgba(15,23,42,.05); font-size: 12px; letter-spacing: .06em; }
            #fg .chip i { width: 8px; height: 8px; border-radius: 3px; display: block; }
            #fg .device { flex: none; width: 236px; height: 486px; margin-top: 120px; border-radius: 40px;
              background: #0f172a; padding: 9px; box-sizing: border-box;
              box-shadow: 0 30px 60px rgba(15,23,42,.22), 0 8px 18px rgba(15,23,42,.12); }
            #fg .device img { display: block; width: 100%; height: 100%; object-fit: cover;
              object-position: top; border-radius: 31px; }
          </style>`,
        );
        const root = document.createElement("div");
        root.id = "fg";
        root.innerHTML = `<div class="text"><span class="brand">Klorn</span><h1>${title}</h1><p>${body}</p><div class="chips">${chips}</div></div>
          <div class="device"><img alt="" src="data:image/png;base64,${shot}"></div>`;
        document.body.appendChild(root);
      },
      { title: copy.title, body: copy.body, chips, shot },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `${OUT}/play/feature-graphic-${short}.jpg`,
      type: "jpeg",
      quality: 95,
    });
    await page.close();
  });
}

test("play icon 512", async ({ browser }) => {
  // Play wants a 32-bit (RGBA) PNG; a page screenshot of an opaque image comes
  // out RGB, so the icon is drawn on a canvas and exported, which is RGBA.
  const page = await browser.newPage();
  const icon = readFileSync(ICON).toString("base64");
  const dataUrl = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, 512, 512);
    return canvas.toDataURL("image/png");
  }, icon);
  mkdirSync(`${OUT}/play`, { recursive: true });
  writeFileSync(`${OUT}/play/icon-512.png`, Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
  await page.close();
});
