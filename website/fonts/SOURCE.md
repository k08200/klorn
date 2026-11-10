# Self-hosted webfonts

| File | Family | Licence | Source |
|---|---|---|---|
| geist-var.woff2 | Geist (variable, 100–900) | OFL 1.1 | npm `geist@1.5.1` (Vercel) |
| instrument-serif{,-italic}.woff2 | Instrument Serif 400 | OFL 1.1 | Google Fonts v5, latin subset |
| pretendard/PretendardVariable.subset.{0..91}.woff2 | Pretendard Variable (45–920), Korean pages | OFL 1.1 (`pretendard/OFL.txt`) | npm `pretendard@1.3.9`, `dist/web/variable/woff2-dynamic-subset`; `pretendard.css` hand-written from the package's dynamic-subset CSS (same unicode-range per chunk) |

Self-hosted because the landing makes no third-party requests. The CSS
previously referenced "PP Editorial New" — a commercial face we hold no
licence for and never actually loaded; the serif accent now loads
Instrument Serif instead of silently falling back to Georgia.

Pretendard is loaded only by the `/ko/` pages (`<link rel="stylesheet" href="/fonts/pretendard/pretendard.css">`,
in place of the Geist preload — Pretendard heads the Korean stack and carries its own
Latin). The 92 chunks are split by `unicode-range`, so a page downloads only the
chunks its text uses.
