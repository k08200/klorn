# Cohort onboarding runbook (Phase 1 — override data)

Goal of this phase: get **~50 real tier corrections (OVERRIDEs) from 3–5 real inboxes**.
That override stream is the denominator the precision gate needs and the fuel the
ontology extraction (Phase 2) runs on. Stars from a Show HN do **not** produce it —
this does. Everything here is grounded in the live app, not generic.

The data path (already wired, verified): connect Gmail → mail is classified into
one of the five lanes → user hits **"Move → X"** on the firewall view → that stamps the
correction (`DecisionLabel.outcome`) → `decision-metrics` counts it.

---

## A. Founder ops — before you invite anyone

1. **Push must work** (PUSH is the headline tier; if it's dark the cohort has nothing to react to):
   - Confirm Render dashboard has `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` set, plus
     `GMAIL_PUBSUB_TOPIC`, `KEEPALIVE_URL`, `ADMIN_EMAILS`. (PR #586 declares these so a
     blueprint sync can't prune them again — merge it so the values persist.)
   - Verify end-to-end after deploy: logged in, `GET /api/diagnostics` → `hasVapid: true`
     + `gmailPushConfigured: true`, **or** `POST /api/notifications/push/test` and confirm a
     real push arrives. The second is the surer check.

2. **Approve each invitee in the waitlist** (admin → waitlist → APPROVED, which fires the
   invite email). That is the only gate: `BETA_GATE_ENABLED=true` makes both the Google and
   the email/password sign-up paths require an APPROVED `Waitlist` row
   (`routes/auth.ts` — the Google path redirects `?error=invite_only` otherwise).

   ⚠️ The OAuth audience is **In production**, unverified (verified 2026-08-04) — leave it
   there. Reverting to Testing would expire every authorization **7 days after consent**,
   sending the whole cohort back through the unverified-app screen weekly, which destroys
   exactly the sustained usage this phase exists to produce.

   The price of production-unverified is a **100-new-user cap counted for the life of the
   project that does not reset** — which is why `BETA_GATE_ENABLED` must stay **on**.
   Without it a single traffic spike burns all 100 slots permanently. Confirm it from
   outside the console: `GET /api/auth/signup-status` must return `{"open":false}`.
   The cap lifts only when restricted-scope verification clears (see
   `google-oauth-verification.md`).

3. **Set `ADMIN_EMAILS` to your account** (`k0820086@gmail.com`) so you can watch the data:
   `decision-metrics` (per-user PUSH recall / over-suppression) and the override count.

4. **Decide the ask.** The classifier is ~86% right, so unprompted corrections are rare —
   you must explicitly ask the cohort to correct what's wrong, or 50 overrides take forever.

---

## B. The message to send each invitee (copy/edit this)

> I added you to Klorn — an attention firewall for your inbox. It sorts mail into
> **PUSH / MEETING / QUEUE / INFO / SILENT** and only interrupts you for what matters. I need one thing from
> you: **when it sorts something wrong, correct it.** That correction is the entire product.
>
> 1. Go to **klorn.ai** → **Continue with Google**. You start on the Free plan (sorting,
>    briefing, one mail account). Pro is $29.99/month with a 7-day trial, from **Billing**.
> 2. Grant Gmail access (it reads to classify, and can act only when you approve — nothing
>    auto-sends by default).
> 3. It classifies your recent mail. **Turn on notifications** so you feel a real PUSH.
> 4. Open the **firewall view** (`/inbox/firewall`). When something is in the wrong lane,
>    hit **"Move → PUSH / QUEUE / SILENT"**. That's it — every "Move" teaches it how *you*
>    tier mail. Correct freely for a few days.
>
> Don't overthink it. The only action that matters is moving the ones it got wrong.

---

## C. What you watch (the gate)

| Signal | Where | Target before Phase 2 |
|--------|-------|-----------------------|
| Override count (real OVERRIDEs) | `decision-metrics` / DecisionLabel rows with non-null `outcome` | **≥ ~50 across 3–5 users** |
| Per-user PUSH recall | `/api/.../decision-metrics` (admin) | trend, not a number yet — recall is an upper bound until overrides exist |
| Over-suppression | same | watch SILENT-overridden-up (confirmed misses) |

**Gate:** do not start Phase 2 (ontology single-source extraction) or any model work until
this override set exists. Phase 2 extracts *from* these corrections — without them it
extracts from nothing.

---

## D. Known friction (name it so the cohort doesn't silently drop off)

- **The unverified-app screen** is the #1 drop point. Pre-warn them in the message (done in B)
  and tell them the exact clicks ("Advanced → Continue").
- **No corrections = no data.** If the classifier is mostly right for a user, they'll have
  little to move. That's fine signal too (high recall), but solicit the misses explicitly.
- **Push silently off** if VAPID isn't set/persisted → they never feel PUSH → the product's
  point is lost. Verify §A.1 first.
