# Demo / promo video pipeline

Regenerates the product demo (en/ko captions), the screen-cut promo (en/ko),
and the landing `demo.webm` + poster from a **live recording of the real app**
— fully automated, no Google OAuth in the loop (password login), no real
personal data (a dedicated mock account with fictional persona emails).

## One command

```bash
DEMO_EMAIL=<demo account email> DEMO_PW=<password> bash scripts/demo-video/run.sh
```

Outputs land in `scripts/demo-video/out/`:

| File | Use |
|---|---|
| `klorn-demo-en.mp4` / `klorn-demo-ko.mp4` | Captioned 60-second walkthrough |
| `klorn-promo-en.mp4` / `klorn-promo-ko.mp4` | Screen-cut promo with copy cards |
| `klorn-demo.webm` + `klorn-demo-poster.jpg` | Landing page (`website/demo.webm`, `website/demo-poster.jpg`) |

To publish: copy the webm/poster over `website/` (auto-deploys to klorn.ai via
`website.yml` on main) and the mp4s over `packages/web/public/klorn-walkthrough*.mp4`.

## The demo account (state it depends on)

A throwaway Google account, connected to Klorn, with an app password set
(Settings → Access security) so Playwright can log in without Google OAuth
(Google blocks automated browsers at its login).

Seed it with the fictional persona mails (self-send via the API — Gmail keeps
the account's display name as the sender): urgent meeting move, invoice,
newsletter, standup notes, investor intro, usage report. Then `POST /api/email/sync`
so classification + summaries run. The account display name (Google *and*
`PATCH /api/auth/me`) is the sender name shown everywhere — keep it a neutral
persona (e.g. "Alex Kim").

## How it works

1. `record-demo.mjs` — Playwright walks login → firewall board → mail list →
   judgment → draft reply → send → calendar → New event → settings, with a
   fake-cursor overlay, and prints `SCENE <name> <sec>` boundaries.
2. `make-assets.py` — PIL renders bilingual caption strips + title/end cards
   (Korean via Apple SD Gothic Neo; macOS fonts).
3. `build-finals.py` — reads `scenes.txt`, burns captions at the exact scene
   windows (ffmpeg PNG overlay — works on slim ffmpeg builds without libass),
   cuts the promo segments relative to scene marks, encodes the landing webm.

Prereqs: node + `playwright` (chromium installed), `ffmpeg`, `python3` + Pillow.

Selector gotchas learned the hard way: use `:visible` (the responsive layout
keeps a hidden mobile duplicate of list links) and exact-name matches where
labels are substrings of other buttons ("All signals" vs "Show all signals").

## Motion-graphics promo (Remotion)

`promo-remotion/` is a code-defined 33-second promo (email-noise intro →
4-tier count-up cards → Ken Burns product shots → outro), en/ko:

```bash
cd scripts/demo-video/promo-remotion
npm install
npx remotion render src/index.ts PromoEN out/promo-en.mp4
npx remotion render src/index.ts PromoKO out/promo-ko.mp4
```

`public/shot-*.png` are stills from the latest demo recording; refresh them
after a re-record with e.g.
`ffmpeg -ss <t> -i ../videos/<take>.webm -frames:v 1 public/shot-firewall.png`
(pick timestamps ~3s into the firewall / judgment / draft / new_event scenes
from `scenes.txt`). Copy in real board numbers (`TIERS` in `src/Promo.tsx`)
if they changed.
