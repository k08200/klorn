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

### Force the graph to rebuild (or the flip is inert for days)

The judge reads a **cached** interaction graph (`getCachedInteractionGraph` —
never rebuilt on the hot path). That cache refreshes only on the weekly batch
(Sunday) or after its 3-day TTL. So engagement that accrued *after* the last
rebuild won't reach the judge until the next one — the flip can look dead for up
to a week even though it's on.

Force it immediately, per user (defaults to the acting admin's own account):

```
curl -s -X POST "https://<api-host>/api/admin/interaction-graph/rebuild" \
  -H "authorization: Bearer <admin-token>"
# → { userId, builtAt, nodeCount, directlyEngaged, orgPropagated, orgImportanceDomains }
```

`directlyEngaged: 0` means the flip is inert for this account — no replies have
accrued yet (S1 needs the user to have manually replied/sent since #768 shipped).
A non-zero count means there's a real signal the judge will now consume.

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
- [ ] Read the instrumentation once a few emails have been judged:
      ```
      curl -s "https://<api-host>/api/admin/decision-metrics?userId=<you>" \
        -H "authorization: Bearer <admin-token>" | jq .engagementGrounding
      ```
      `total > 0` proves the grounding is firing on real classifications; a
      `correctionRate` at or below the overall `overall.overrideRate` means the
      signal is aligned with you (you're not overriding grounded decisions more
      than average). A high `correctionRate` on grounded rows is the signal to
      roll back and reconsider.

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

## 2026-07-16 addendum: read-behavior fact (flip is no longer cold-start)

The first real-mail measurement found the flip would have been a **no-op** on
day one: `contactEngagementScore` had a single row (the founder's own address)
because outbound replies and dismisses are the only counted actions, and
neither accrues without heavy in-app use. Meanwhile the mailbox itself already
held a strong attention signal: the founder reads **100%** of two senders the
judge was burying as SILENT, and **4%** of another (baseline 57%).

The engagement channel now carries that passive half: `senderFacts.readBehavior`
(`{ read, total }` over the last 90 days, suppressed under 3 mails, thresholds
in `sender-policy.ts` `READ_BEHAVIOR`). Same flag, same soft-grounding doctrine
— it feeds senderTrust wording, never a tier decision. `isRead` is synced from
Gmail, so it measures real reading wherever it happens, not just in-app.

Flip consequence: `CONTACT_ENGAGEMENT_IN_JUDGE=true` now has **data from the
first classification** (every sender with ≥3 recent mails grounds a fact), and
the effect is eval-visible — the fact is numeric, so `--emit-context` snapshots
it into the committed fixtures and the readout measures it.
