# Google OAuth / CASA verification — submission pack

Everything needed to submit Klorn's OAuth consent screen for verification.
Paste the justification text verbatim, record the demo video from the shot
list, then submit. Restricted Gmail scopes → this also triggers the annual
**CASA** security assessment (see the end).

Google Cloud project: the Klorn project under `k0820086@gmail.com`.
Console path: **APIs & Services → OAuth consent screen**.

---

## The scopes Klorn requests (from `packages/api/src/gmail.ts`)

| Scope | Google tier | Needs CASA? |
|---|---|---|
| `…/auth/gmail.readonly` | **Restricted** | ✅ yes |
| `…/auth/gmail.modify` | **Restricted** | ✅ yes |
| `…/auth/gmail.send` | Sensitive | (covered by CASA) |
| `…/auth/calendar.events` | Sensitive | — |
| `…/auth/calendar.readonly` | Sensitive | — |
| `…/auth/userinfo.email` | Non-sensitive | — |
| `…/auth/userinfo.profile` | Non-sensitive | — |
| `openid` | Non-sensitive | — |

> Because two **restricted** Gmail scopes are present, the app requires full
> verification **and** an annual CASA assessment. There is no way around CASA
> while reading mail content — it is the price of the core firewall feature.

**Optional scope narrowing (reduces review friction):** `calendar.readonly` is
largely redundant with `calendar.events` (which already reads + writes events).
Dropping `calendar.readonly` would present a tighter scope set to reviewers.
This is a code change (remove it from the three scope arrays in `gmail.ts` and
re-test conflict detection) — decide before submitting, since the consent
screen must match the scopes the code requests.

---

## Per-scope justification (paste into the consent screen)

Google asks, for each sensitive/restricted scope: **what it's for**, **how the
data is used**, and **why a narrower scope won't work**. Use these:

**`gmail.readonly` — read message content**
> Klorn is an AI email firewall. It reads incoming messages to classify each
> one into four attention tiers (interrupt now / review later / silence /
> auto-handle) and to generate short summaries, so the user is only interrupted
> by mail that matters. Metadata-only scopes are insufficient because the
> classification and summaries require the message body and subject.

**`gmail.modify` — organize the mailbox**
> Klorn acts on the user's triage decisions: marking messages read, archiving,
> and applying/removing labels as part of sorting the inbox. `gmail.modify` is
> the narrowest scope that permits changing read state and labels; `gmail.send`
> alone cannot modify messages, and full-mailbox scope is broader than needed
> (Klorn never permanently deletes mail).

**`gmail.send` — send replies the user approves**
> Klorn drafts replies and, only when the user approves (or enables an explicit
> auto-reply rule), sends them from the user's own account. `gmail.send` is the
> minimal scope for outbound mail and does not grant read access on its own.

**`calendar.events` — meeting prep and scheduling from email**
> Klorn reads and creates calendar events to prepare the user for upcoming
> meetings surfaced from their mail and to schedule events the user confirms
> from an email. Event read+write is required; a read-only scope cannot create
> the events the user asks Klorn to add.

**`calendar.readonly` — free/busy conflict detection** *(only if kept)*
> Klorn checks the user's existing calendar to detect conflicts before
> proposing a meeting time. Read-only access to calendar data is sufficient for
> conflict detection.

**`userinfo.email` / `userinfo.profile` / `openid` — sign-in**
> Standard OpenID Connect sign-in to identify the account and display the user's
> name/email. No further processing.

---

## Privacy policy — Limited Use (must be true before submitting)

Google's **Limited Use** policy for restricted scopes requires the privacy
policy (`https://klorn.ai/privacy`) to state, in substance:

- What data is accessed (Gmail messages, calendar) and **why**.
- That the data is used **only** to provide/improve the user-facing features
  (the firewall/triage), **not** sold, **not** used for ads, and **not** used
  to train generalized AI models.
- Human access is limited (only with consent, for security/legal, or aggregated/
  anonymized).
- How the user can **revoke** access and **delete** their data.

> ✅ Action: confirm `klorn.ai/privacy` contains an explicit "Limited Use /
> Google API Services User Data Policy" section covering the above. If it's
> missing or vague, that's the #1 cause of restricted-scope rejection — ask me
> and I'll draft the section to drop into the privacy page.

---

## Demo video (Google requires it — YouTube link, can be unlisted)

Record on a screen (phone or desktop) showing the **real OAuth consent screen**
and each scope in use. Suggested shot list (~2–3 min):

1. Show the app's OAuth flow: tap "Sign in with Google" → the **Google consent
   screen listing the exact scopes** → grant. (Reviewers must see the OAuth
   client + scopes on screen.)
2. **gmail.readonly / modify**: show the inbox classified into the four tiers;
   open a message; show a summary; mark read / archive / label a message.
3. **gmail.send**: compose or approve a reply and send it.
4. **calendar.events (+ readonly)**: show a meeting surfaced from mail; create
   an event / show conflict detection.
5. Show **sign-out / disconnect** and where the user revokes access + deletes
   data (the account/settings screen).

Narrate briefly what each scope does as you show it. Keep the OAuth client ID
visible in step 1 (reviewers match it to the project).

---

## Consent screen — what to fill (order)

1. **App info**: name `Klorn`, user support email, app logo, developer contact.
2. **App domain**: home `https://klorn.ai`, privacy `https://klorn.ai/privacy`,
   terms `https://klorn.ai/terms`. Authorized domain `klorn.ai`.
3. **Scopes**: add the scopes above; paste each justification.
4. **Test → Production**: set the app to In production / **Submit for
   verification**. Attach the demo video link.
5. Google reviews → for the restricted scopes they will email **CASA**
   instructions.

---

## CASA (after the console submission)

- Google emails a link to authorized **CASA assessors**. Pick one from their
  list, contact them, and complete a **Tier 2** assessment (self-assessment
  questionnaire + an authorized scan of the app).
- The assessor issues a **Letter of Assessment (LoA)** to Google; verification
  completes once Google has it.
- **Annual**: CASA must be re-done every ~12 months regardless of changes.
- Cost: roughly **$540–$1,800/yr** depending on assessor (historical estimate —
  confirm with the assessor).

---

## After verification — when features change (rule of thumb)

- **No new scope** (UI, new classification logic, features within existing Gmail/
  Calendar access) → **no re-verification**; just ship.
- **New scope added** → update the consent screen (new scope + justification +
  refreshed demo video) and **re-submit**; if it's another restricted scope,
  the CASA assessment scope expands too.
- **Identity change** (name/logo/domain/privacy policy) → update consent screen;
  usually a lighter re-review.
- **Design to reuse the already-granted scopes** so most features never need
  re-verification. (Linking a second Gmail inbox already reuses the same scope
  set — no new verification — see `gmail.ts` `getLinkInboxAuthUrl`.)
