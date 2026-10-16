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

const html = readFileSync(join(here, 'banner.html'), 'utf8')
  .replace('SKY', pathToFileURL(join(root, 'website/media/sky/dusk-1280.jpg')).href)
  .replace('ICON', pathToFileURL(join(root, 'apps/desktop-mac/Resources/AppIcon.png')).href);
const tmp = join(here, '.banner.rendered.html');
writeFileSync(tmp, html);

const browser = await chromium.launch();
try {
  for (const scale of SCALES) {
    const page = await browser.newPage({ viewport: { width: CSS_WIDTH, height: 300 }, deviceScaleFactor: scale });
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
