/**
 * WCAG 2.x contrast math for design-token checks. Pure and import-free so the
 * api vitest suite can pin token pairs (see web-lane-chip-contrast.test.ts).
 */

export type Rgb = readonly [number, number, number];

const HEX_RE = /^#([0-9a-f]{6})$/i;

/** "#rrggbb" → [r, g, b] in 0..255. Throws on anything else. */
export function parseHex(hex: string): Rgb {
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`Expected #rrggbb, got "${hex}"`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Source-over composite of `fg` at `alpha` (0..1) onto opaque `bg`. */
export function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}
