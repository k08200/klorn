// Renders the landing's macOS notification banner (demo data) to
// website/media/app-2026-10/notification-light-{396,792}.webp.
// A drawn HTML/CSS banner, not a screenshot: no app is launched.
// Usage (after `pnpm install`): node scripts/site-banner/render.mjs
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const outDir = join(root, 'website/media/app-2026-10');
const CSS_WIDTH = 396;
const SCALES = [1, 2];

const { chromium } = createRequire(join(root, 'packages/web/package.json'))('@playwright/test');
// sharp is a root dependency override only, so resolve it from the pnpm store.
const pnpm = join(root, 'node_modules/.pnpm');
const sharpDir = readdirSync(pnpm).find((d) => d.startsWith('sharp@'));
if (!sharpDir) throw new Error('sharp not installed: run pnpm install');
const sharp = createRequire(import.meta.url)(join(pnpm, sharpDir, 'node_modules/sharp'));

const ICON_PT = 38; // icon slot in the banner, CSS px
const MARK_SHARE = 1; // mark.png already carries the K's margin within its 1024px box
const SUPERELLIPSE_N = 5; // continuous-corner tile, ~22% corner radius

// macOS-style continuous-corner squircle path in an n x n box.
function squircle(n, inset = 0) {
  const r = n / 2 - inset;
  const pts = [];
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * 2 * Math.PI;
    const c = Math.cos(t), s = Math.sin(t);
    const x = Math.sign(c) * Math.abs(c) ** (2 / SUPERELLIPSE_N);
    const y = Math.sign(s) * Math.abs(s) ** (2 / SUPERELLIPSE_N);
    pts.push(`${(n / 2 + r * x).toFixed(3)},${(n / 2 + r * y).toFixed(3)}`);
  }
  return `M${pts.join('L')}Z`;
}

// The app icon drawn at exactly the device pixels it occupies: the brand K
// (1024px source, Lanczos-downscaled) on a white squircle tile with a 0.5pt
// inner hairline, so it stays crisp instead of being squashed by the browser.
async function iconDataUrl(scale) {
  const n = ICON_PT * scale;
  const d = squircle(n);
  const tile = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eeeeef"/></linearGradient></defs>
    <path d="${d}" fill="url(#g)"/></svg>`);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}"><path d="${d}" fill="#000"/></svg>`);
  const hair = 0.5 * scale;
  const border = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}">
    <path d="${squircle(n, hair / 2)}" fill="none" stroke="rgba(0,0,0,0.16)" stroke-width="${hair}"/></svg>`);
  const k = Math.round(n * MARK_SHARE);
  const mark = await sharp(join(root, 'website/brand/mark.png')).resize(k, k, { kernel: 'lanczos3' }).png().toBuffer();
  const off = Math.round((n - k) / 2);
  const png = await sharp(tile)
    .composite([{ input: mark, left: off, top: off }, { input: mask, blend: 'dest-in' }, { input: border }])
    .png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

const template = readFileSync(join(here, 'banner.html'), 'utf8')
  .replace('SKY', pathToFileURL(join(root, 'website/media/sky/dusk-1280.jpg')).href);
const tmp = join(here, '.banner.rendered.html');

const browser = await chromium.launch();
try {
  for (const scale of SCALES) {
    const page = await browser.newPage({ viewport: { width: CSS_WIDTH, height: 300 }, deviceScaleFactor: scale });
    writeFileSync(tmp, template.replace('ICON', await iconDataUrl(scale)));
    await page.goto(pathToFileURL(tmp).href);
    await page.evaluate(() => document.fonts.ready);
    const png = await (await page.$('.stage')).screenshot({ omitBackground: true });
    const file = join(outDir, `notification-light-${CSS_WIDTH * scale}.webp`);
    await sharp(png).webp({ quality: 88, alphaQuality: 90, effort: 6 }).toFile(file);
    const { width, height } = await sharp(file).metadata();
    console.log(`${file} ${width}x${height} ${statSync(file).size} bytes`);
    await page.close();
  }
} finally {
  await browser.close();
  rmSync(tmp, { force: true });
}
