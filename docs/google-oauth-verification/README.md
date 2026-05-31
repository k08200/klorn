# Google OAuth Verification — Prep & Status

> Owner: founder · Started: 2026-05-31 · Strategy: **Gate 1 first** (do all
> free, controllable prep now; defer the paid CASA contract until after the PoC
> gate / first real users).

Klorn requests **restricted Gmail scopes**, so this app is on the **restricted
verification track**, which ends in a **paid CASA security assessment**. There
is no self-assessment shortcut anymore (deprecated Nov 2024). Plan for a
**2–6 month** end-to-end timeline and a **recurring ~$540–$1,800/yr** lab fee.

---

## 1. Scope inventory (from `packages/api/src/gmail.ts`)

| Scope | Tier | Triggers CASA? |
|---|---|---|
| `openid`, `userinfo.email`, `userinfo.profile` | Non-sensitive | No |
| `gmail.send` | **Sensitive** | No |
| `https://www.googleapis.com/auth/calendar` | **Sensitive** | No |
| `gmail.readonly` | **RESTRICTED** | **Yes** |
| `gmail.modify` | **RESTRICTED** | **Yes** |

Two restricted scopes (`gmail.readonly`, `gmail.modify`) → **CASA is unavoidable**
as long as the product reads email server-side. Reading email is the core
function, so there is no way to downscope out of the restricted track.

---

## 2. ⚠️ Two real issues found in code (fix before submitting)

### Issue A — Calendar scope mismatch (policy vs code)
- **Code** (`gmail.ts:47`, `:66`) requests `https://www.googleapis.com/auth/calendar`
  (full read/write incl. calendar management & ACLs).
- **Privacy policy** (`privacy/page.tsx:145`) says `calendar.events`.
- Reviewers cross-check requested scope ↔ policy ↔ demo. A mismatch is a common
  rejection cause, and full `calendar` will draw a "downscope" request anyway.
- **Fix:** change code to `https://www.googleapis.com/auth/calendar.events`
  (sufficient for read events + create/edit-with-approval). This both fixes the
  mismatch and satisfies minimum-scope. ← recommended.

### Issue B — Login flow bundles everything (over-broad first consent)
- `getLoginAuthUrl()` (`gmail.ts:53-68`) requests **all** Gmail + Calendar
  scopes at *login* time, alongside identity scopes.
- Google prefers **incremental authorization**: request `openid/email/profile`
  at login, then request Gmail/Calendar scopes only when the user actually
  connects those features.
- Not strictly blocking, but bundling restricted scopes into the very first
  consent is a yellow flag and worsens the consent-screen UX shown in your demo.
- **Decision needed:** keep bundled (simpler) vs split (cleaner for review).
  Not required for Gate 1; revisit before final submission.

---

## 3. Current readiness (what's already done — verified in code)

- ✅ Privacy policy live at `/privacy` — discloses data access, Limited Use
  clause, retention/deletion, contact, per-scope justification.
- ✅ Terms of service live at `/terms`.
- ✅ Homepage (`app/page.tsx`) describes the product and footer links to
  Privacy + Terms + Contact (not a bare login page). ✔ meets homepage req.
- ✅ Production domain `https://app.klorn.ai`; redirect URI
  `https://app.klorn.ai/api/auth/google/callback`.
- ✅ Email send treated as sensitive / approval-gated (matches justification).

## 4. Gate 1 checklist (free, do now — in order)

- [ ] **Fix Issue A** (downscope calendar → `calendar.events`) and redeploy.
- [ ] **Decide Issue B** (bundle vs incremental).
- [ ] **Verify the domain** `klorn.ai` (+ `app.klorn.ai`) in **Google Search
      Console** with the *same Google account that owns the Cloud project*
      (`k0820086@gmail.com`). DNS TXT or HTML file. Near-instant.
- [ ] **Consent screen / Branding** in Cloud Console — fill from
      [`consent-screen-values.md`](./consent-screen-values.md).
- [ ] **App logo** — 120×120 px PNG, ≤1 MB, identical to homepage mark.
- [ ] **Scope justification** — paste from
      [`scope-justification.md`](./scope-justification.md).
- [ ] **Demo video** — record per [`demo-video-script.md`](./demo-video-script.md),
      consent screen language set to **English**, upload unlisted to YouTube.
- [ ] **Test account** for reviewers (the beta gate blocks the homepage CTA —
      reviewers need working creds + steps to reach the connected state).
- [ ] Confirm developer-contact inbox is monitored (review threads die on
      non-response).

## 5. Gate 2 — Brand + scope review (after Gate 1 submit)
- Google reviews branding (2–3 business days if clean) then scope justification
  + demo (days → weeks, with back-and-forth).

## 6. Gate 3 — CASA (deferred, paid, final step)
- Triggered by Google **after** Gate 2 passes.
- Tier 2 (server-backed, restricted): authorized lab runs/validates a DAST scan;
  you remediate; lab issues a **Letter of Validation**.
- Cost ~$540 (TAC Security, Google-preferred) up to ~$1,800; **annual
  recertification** required.
- Self-scan tooling can be run early as a **readiness pre-check** only.
- ⏸️ **Do not contract a lab until PoC passes / first real users** (per current
  decision). Run the self-scan readiness check earlier if convenient.

## 7. 100-user cap (current reality)
- Until verified, the app runs in unverified mode with a **lifetime 100-user
  cap per project** (cannot be raised/reset without verification) + the
  "unverified app" interstitial. Fine for PoC dogfooding.

## 8. Top rejection causes to pre-empt
1. Branding mismatch across consent screen / homepage / demo → keep identical.
2. Scope ↔ policy ↔ demo mismatch → see Issue A.
3. Over-broad scopes → minimum-scope; expect downscope requests.
4. Demo defects → English consent screen, show full grant flow, demonstrate
   *each* scope's real usage on screen.
5. Unverified domain → Search Console first.
6. Limited Use violation (ads / sale / unconsented human reading / training on
   user data) → policy already covers this; keep behavior aligned.

---

### Sources
Brand verification, restricted-scope verification, demo-video, minimum-scope,
and CASA Tier 2 docs (Google for Developers / Cloud Console Help / App Defense
Alliance), retrieved 2026-05-31. CASA self-scan deprecated Nov 2024; exact lab
pricing is third-party/indicative — get a live quote before contracting.
