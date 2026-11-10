// Landing captures (website/media/app-2026-10/) from KlornMac --render-previews.
// Every output is a real product render with the demo fixtures.
// Crop boxes are in 2560x1600 render pixels (2x of a 1280x800pt window) and
// were matched against the previous assets so the new files drop into the
// same slots. They were re-checked against the Korean fixture set
// (2026-10-17, again 2026-10-23 with the 3-line mail rows): Korean subjects
// and reasons are shorter than the English ones, so every box still frames
// the same panel in both variants.
// The notification banners come from scripts/site-banner/render.mjs; the
// briefing tile is markup in the landings (.brief in website/landing.css),
// not a capture. Normally run through make.sh, which renders each variant
// first.
//
//   SHARP=<path to sharp> node make.mjs <renders dir> <out dir> [variant] [--no-mobile]
//
// variant replaces "light" in every output name ("ko-light").
// It only names the files — the renders dir must already hold that appearance
// and language. --no-mobile skips the phone-width (-m-) crops.
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP ?? "sharp");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [rendersDir, outDir, variant = "light"] = args;
const skipMobile = process.argv.includes("--no-mobile");
if (!rendersDir || !outDir) {
  console.error("usage: node make.mjs <renders dir> <out dir> [variant] [--no-mobile]");
  process.exit(2);
}

const WEBP_QUALITY = 80;
const FULL = null; // whole 2560x1600 frame

// [render, crop box or FULL, [[output name, width, height], ...]]
const JOBS = [
  ["today", FULL, [["today-light-2560", 2560, 1600], ["today-light-2000", 2000, 1250], ["today-light-1200", 1200, 750]]],
  ["today", { left: 1900, top: 116, width: 640, height: 370 }, [["day-light-640", 640, 370], ["day-light-320", 320, 185]]],
  ["mail-all", FULL, [["mail-light-2000", 2000, 1250], ["mail-light-1200", 1200, 750]]],
  ["mail-all", { left: 442, top: 0, width: 840, height: 1000 }, [["mail-m-light-840", 840, 1000]]],
  ["mail-all", { left: 1282, top: 0, width: 1278, height: 640 }, [["reason-light-1278", 1278, 640], ["reason-light-640", 640, 321]]],
  // The #day bento tile shows only the Approvals pane: the full window at
  // tile width set the app text near 8 CSS px. Same box at every width, so
  // there is no phone-only (-m-) crop. 840 is the box at native render
  // pixels (no resampling), the sharpest this crop can be on 2x screens.
  ["assistant", { left: 442, top: 0, width: 840, height: 780 }, [["approvals-light-840", 840, 780], ["approvals-light-656", 656, 609], ["approvals-light-400", 400, 371]]],
];

mkdirSync(outDir, { recursive: true });
let total = 0;
for (const [render, box, outputs] of JOBS) {
  const src = join(rendersDir, `${render}.png`);
  const meta = await sharp(src).metadata();
  if (meta.width !== 2560 || meta.height !== 1600) {
    throw new Error(`${src} is ${meta.width}x${meta.height}, expected 2560x1600`);
  }
  for (const [baseName, width, height] of outputs) {
    if (skipMobile && baseName.includes("-m-")) continue;
    const name = baseName.replace("-light-", `-${variant}-`);
    const file = join(outDir, `${name}.webp`);
    const base = box ? sharp(src).extract(box) : sharp(src);
    await base
      .resize(width, height, { fit: "fill", kernel: "lanczos3" })
      .webp({ quality: WEBP_QUALITY, effort: 6 })
      .toFile(file);
    const out = await sharp(file).metadata();
    if (out.width !== width || out.height !== height) {
      throw new Error(`${file} came out ${out.width}x${out.height}, expected ${width}x${height}`);
    }
    const bytes = statSync(file).size;
    total += bytes;
    console.log(`${name}.webp ${width}x${height} ${(bytes / 1024).toFixed(1)} KB`);
  }
}
console.log(`total ${(total / 1024).toFixed(1)} KB`);
