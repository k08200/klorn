# Engagement Learning Flip Runbook

How to turn on the "learn from my actions" engagement loop in the classifier.
Everything below is already built and merged; nothing here ships code. The flip
is **one environment variable**, and it is fully reversible with no data change.

Current state (verified at HEAD): `CONTACT_ENGAGEMENT_IN_JUDGE` defaults to
**off**. The measurement layer is always-on and already accruing; only the
*classifier's consumption* of that signal is gated.

---

## What the loop does

The user's own actions teach the firewall who matters:

1. **Measure (always-on, #768).** Every manual reply / send / compose bumps
   `ContactEngagementScore.outboundCount` for that contact; every dismiss bumps
   `dismissCount`. Auto-replies are excluded (gaming guard). This runs regardless
   of the flag.
2. **Graph (always-on, #768/#772).** The interaction graph turns those counts
   into a per-contact `learnedImportance` (0..1) and propagates a soft, discounted
   prior to quiet peers at the same **organizational** domain (`orgImportance`).
3. **Surface (always-on, #771/#774).** The web relationship graph draws engaged
   contacts larger and pink ("you engage"), org-inferred peers purple; the macOS
   reading pane shows a "You engage with this sender · replied N times" chip.
   These are display-only and do **not** depend on the flag.
4. **Consume (flag-gated, #768/#772).** *Only this step* is gated. With the flag
   on, `buildJudgeContext` appends a hedged grounding line to the judge prompt —
   "the recipient strongly engages with this sender…" (direct) or "…engages with
   others at this sender's organization, weigh it lightly" (propagated). It feeds
   `senderTrust` as **soft grounding text; the LLM still scores. It is never a
   tier decider** and never touches the deterministic `buildPrior` short-circuit.

## Why the flip is safe (evidence, not assertion)

- **The eval gate is flag-independent by construction.** The eval harness
  (`scripts/poc-accuracy.ts` → `judgeEmails` → `judgeEmail`) runs with
  `EMPTY_JUDGE_CONTEXT` and never calls `buildJudgeContext`, so the only
  flag-gated code (`fetchLearnedImportanceFact`) is unreachable on the eval path.
  Confirmed: the offline gate (`judge-eval-set.test.ts`) is **5/5 identical with
  the flag off and on**. Flipping cannot regress the ≥80% / PUSH-recall / SILENT-
  precision floors.
- **The wiring is validated.** `judge-context-engagement-flip.test.ts` (#773)
  exercises the *real* `buildJudgeContext` path with the flag on: direct
  engagement renders and beats an org prior; a cold-start org peer gets the
  hedged prior (never a "replied N times" claim); public providers never
  propagate; no signal → no fact.
- **Anti-abuse rails (before you flip):** propagation requires **≥2 distinct
  engaged contacts** at a domain (one farmed/pretext reply can't lift a whole
  domain); ~40 public providers (gmail/outlook/naver/…) are denylisted from
  propagation; dismiss-only contacts (importance 0) don't tag peers; the cache
  read fails soft (a corrupt row degrades to "no fact", never throws).

## What the eval CANNOT tell you (important)

The eval proves **no regression**, not **benefit**. The synthetic 50-email set
has no engagement history, and the eval path doesn't build a real context — so
the feature's *upside* is unmeasurable in CI. **Benefit only appears on real
accounts with genuine reply history.** Validate it by dogfooding, not by eval.

## Pre-flip

Nothing to provision — no keys, no migration. `ContactEngagementScore` and the
interaction graph have been accruing since #768 merged, so a real account already
has data to consume the moment the flag flips.

- [ ] Confirm on the dogfood account (real reply history) that the web graph
      shows pink "you engage" nodes and the desktop chip appears — i.e. there is
      a learned signal to consume. If the graph is all blue, there's nothing to
      turn on yet.

## The flip

On Render (API service), set — no code or web deploy needed:

```
CONTACT_ENGAGEMENT_IN_JUDGE=true
```

What changes at that moment: for a sender the user engages with (directly, or
via an engaged org), the judge prompt gains one hedged grounding line that nudges
`senderTrust`. Nothing else. Classification of strangers is byte-identical.

## Post-flip validation (dogfood — the only real test)

On the founder's real account (`k0820086@gmail.com`, which has reply history):

- [ ] Re-judge a few emails from people you actually reply to: the tier reason /
      senderTrust should reflect the engagement, and the tier should be sensible
      (not everything you've ever replied to slammed to PUSH — it's a soft prior).
- [ ] Cold-start check: a new sender at a company where you engage with ≥2 people
      gets a *mild* lift, not a strong one.
- [ ] Over-trust check: a marketing/stranger sender at a **public** domain (gmail
      etc.) gets **no** lift even if you engage with someone else there.
- [ ] Watch for any sender you dismiss a lot still being lifted — it shouldn't be
      (dismiss-only → importance 0 → no fact).

## Rollback

Set `CONTACT_ENGAGEMENT_IN_JUDGE=false` and redeploy the env. The grounding line
disappears on the next classification; **no data changes** — the measurement
layer keeps accruing (it's always-on and flag-independent), so a later re-flip
resumes with richer data. Safe to toggle freely.

## Known limits (accepted, tracked)

- **Benefit is unmeasured until real-data observation** — the eval structurally
  can't show it (see above). Treat the first flip as a measured dogfood, not a
  proven win.
- **Propagation is domain-based**, not co-recipient — a first hop only. A true
  cluster graph (people cc'd together) is future work.
- **No SPF/DKIM/DMARC** in the codebase, so the `From` domain used for
  propagation is attacker-assertable. Bounded by the ≥2-contact gate + public-
  domain denylist + soft-grounding-only (never a decider), but a domain-reputation
  / tenure gate is the recommended hardening before heavy reliance.
