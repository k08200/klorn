# Founder actions — the things code cannot do (2026-08-10)

Everything engineering can close is closed. What remains needs an account,
a payment method, or a human identity. Ordered by deadline pressure.

## A. CASA Tier 2 → Google OAuth verification (deadline: DAST before 2026-10-05)

Pre-scan work finished 2026-08-04 (#1007): CORS quiet-denial, TLS/header/rate-limit
posture verified live, prod dependency vulnerabilities driven to zero. **Re-verified
2026-08-10: one new high advisory had appeared (nanoid via sanitize-html→postcss)
and was closed by a targeted override — `pnpm audit --prod` is now clean again.**
Re-run it once more the day you submit; advisories keep arriving.

Facts that shape the plan (confirmed 2026-08-04): the self-scan-only compliance
path is retired — an authorized assessor is mandatory. TAC runs ~$540–1,800 per
app, other labs ~$3,000. Validation takes several weeks and CASA renews annually.

1. **Search Console** — verify ownership of `klorn.ai`. Required before the OAuth
   console will accept the submission.
2. **Demo video** — script and captions are written and ready to shoot:
   `docs/oauth-verification/demo-video-script.md`, `demo-video-captions.srt`.
   Record it AFTER the app is in the state you want reviewers to see.
3. **Console submission** — paste-ready copy lives in `docs/oauth-verification/`
   (`scope-justifications.md`, `limited-use-disclosure.md`). Submit; Google then
   routes you to an assessor.
4. **Assessor purchase** — pay TAC (or another lab) and schedule the DAST scan.
   This is the item with the hard date: the scan must land before 2026-10-05.

Constraint that holds until the Letter of Assessment is issued: **every provider
flag stays OFF** (`ICLOUD_INBOX_ENABLED`, `OUTLOOK_INBOX_ENABLED`, and the
selector/multi-inbox flags). No new Google scopes at any point — that would
restart verification.

## B. Azure app registration → unblocks Outlook

The whole Outlook path (OAuth connect, delta sync, Graph actions, settings UI)
is merged and dark. It needs one registration:

1. Azure Portal → App registrations → New. **Supported account types must
   include personal Microsoft accounts** — outlook.com users are the point.
2. Redirect URI (Web): `https://klorn-api.onrender.com/api/auth/outlook/callback`
3. API permissions → Microsoft Graph → **delegated**: `Mail.Read`,
   `Mail.ReadWrite`, `Mail.Send`, `offline_access`. (The 2026-12-31 change
   requiring `Mail-Advanced.ReadWrite` covers editing subject/body/recipients on
   delivered mail — Klorn never does that. Re-verified 2026-08-06.)
4. Certificates & secrets → new client secret.
5. Render → klorn-api: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and
   `MS_REDIRECT_URI` = the URI above. (`MS_TENANT` defaults to `common`, which
   is what you want.)
6. Leave `OUTLOOK_INBOX_ENABLED` OFF until the LoA. Until then the routes 404
   by design — the connect endpoint answers 503 without the credentials, which
   is the intended loud failure rather than a broken consent screen.

## C. Paddle → billing at $8.99/mo

Payment provider is Paddle, not Stripe (`billing/paddle.ts`,
`routes/webhook.ts`). Paddle support confirmed 2026-08-10 that a **sole
trader / individual** can sign up — no company registration needed.

1. Sign up; submit `klorn.ai` for domain review. Have terms, privacy, and
   refund pages reachable from the landing — domain review checks them.
2. Identity verification (they email you), then their final review.
3. Create the product and a **$8.99/mo** price. Copy the price id.
4. Render → klorn-api: `PADDLE_API_KEY`, `PADDLE_PRO_PRICE_ID`,
   `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV` — start at `sandbox`.
4b. Vercel → klorn-web: `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` (and
   `NEXT_PUBLIC_PADDLE_ENV=sandbox` while testing). **Easy to miss** — the
   server env alone is not enough: without the client token Paddle.js never
   loads and the upgrade button silently does nothing.
5. Paddle → Notifications → webhook to
   `https://klorn-api.onrender.com/api/webhook/paddle`, signed with the same
   secret.
6. Sandbox end-to-end: checkout → webhook → `User.plan` flips to PRO →
   entitlement-gated features open. Only then set `PADDLE_ENV=production`.
7. `PAYWALL_ENABLED=true` is a **separate, deliberate** flip
   (`docs/launch/paywall-flip-runbook.md`). Until it flips every gate is inert
   and multi-inbox is free.
8. Local payment methods (KakaoPay, Pix, iDEAL, …) need **local currency**, not
   just a dashboard checkbox: the PRO price is USD-only, so a Korean buyer is
   quoted USD and KakaoPay is never eligible for them. Turn on automatic
   currency conversion or add local unit prices to the price. Full rules and
   the per-method country/currency table are in
   `docs/launch/paywall-flip-runbook.md` → "Payment methods at checkout".

Keep three numbers in sync: the landing copy ($8.99, EN + KO), the Paddle
price, and `TRIAL_DAYS` (7).

## D. Standing config decisions already made

- Global daily cost ceiling: **$50/day** (raised from $10 on 2026-08-10 —
  measured steady state at 100 users is ~$7/day; see launch-plan.md P2b).
- Model fallback chain: cheap **paid** SKUs, no `:free` entries.
- Attention aging (`ATTENTION_AGING_ENABLED`) is built and OFF — flipping it
  is a product decision about what leaves the board.

## E. Numbers the site could publish but has not measured

### E1. Throughput — one command, read-only, safe against prod

The competitive teardown's one usable observation about social proof: at eight
users, user counts are the wrong number and throughput is the right one. Clean
Email publishes "5 billion emails", SaneBox "10.5 billion", Mailstrom "400
million" — none of them publishes a customer count. Throughput is honest at any
scale and only goes up.

Nothing produced that number, so nothing could be published. `throughput` does:

```bash
DATABASE_URL=<prod> pnpm --filter @klorn/api throughput -- --out=./throughput.json
```

One `groupBy` over `AttentionItem.tier` plus two counts. No writes, no LLM, no
running server. Legacy rows go through `normalizeTier`, so the lane breakdown
matches what the product shows rather than what the column stores. Exit 2 means
no classified rows in the window — "nothing judged yet", not "judged nothing".

It reports `classified`, `interrupted` (PUSH + MEETING), `keptQuiet`
(QUEUE + INFO + SILENT), `keptQuietRate` and the per-lane breakdown.

**What it is not:** an accuracy number. It says how many decisions were made and
how many stayed quiet, never whether they were right. Accuracy is `eval:real`
(the 53-email labelled set, Push/Queue/Silent only) and `decision-metrics`
(bounded, confirmed overrides only). Publish them side by side; do not blend
them into one figure.

**Then:** the landing has no throughput line yet. Once the number exists, it
goes next to the 94.3% in the "Measured, not promised" section, dated, with the
window it covers stated — same rule as every other number on that page.

### E2. Demo and promo videos — re-render needed

`website/media/klorn-demo.mp4` and `klorn-promo.mp4` were recorded 2026-08-10,
before the five-lane flip, so their burnt-in captions still read
`PUSH / QUEUE / SILENT / AUTO`. Both generators are corrected and CI now fails
on a retired lane in either of them, but the rendered assets can only be
regenerated from a live recording:

```bash
DEMO_EMAIL=<demo account> DEMO_PW=<password> bash scripts/demo-video/run.sh
```

Needs the password-login demo account with its seeded persona mail
(`scripts/demo-video/README.md`), plus ffmpeg and python3 + Pillow locally.
The motion-graphics promo is separate and needs no recording:

```bash
cd scripts/demo-video/promo-remotion && npm install
npx remotion render src/index.ts PromoEN out/promo-en.mp4
npx remotion render src/index.ts PromoKO out/promo-ko.mp4
```

Until then README says plainly that the videos predate the flip. The landing
embeds no video, so klorn.ai is unaffected.

## F. Unified platform (2026-09-28)

FA-1 to FA-9 are listed in `../providers/unified-platform-plan.md` under
"Founder actions". That file is canonical; do not copy the list here.
