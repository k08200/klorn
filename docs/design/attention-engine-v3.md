# Attention Engine v3: facts, relationships, behaviour, policy

Status: **DIRECTION APPROVED** by the founder on 2026-10-31 ("단계 싹 다 진행하자 … 미래도 정확하게 바라볼 수 있게").
Every phase ships behind a flag that is **OFF by default**. The founder flips each one as a separate decision.
The five lanes PUSH / MEETING / QUEUE / INFO / SILENT stay (LOCKED, `tier-ontology-v2.md`). In v3 they become a *view* computed from the layers below, not the thing the model is asked to produce.

This document is the contract that every v3 session builds against. Change it by PR before changing code that depends on it.

## 1. Why: evidence from production and the eval sets

| Finding | Evidence |
|---|---|
| The policy is coupled to one model's calibration. | `TIER_THRESHOLDS` (`packages/api/src/judge/tier-policy.ts`) sets PUSH at urgency ≥ 0.7 AND confidence ≥ 0.7. It was introduced in #522/#547 (2026-06) and has never been recalibrated. `claude-sonnet-5` cleared urgency 0.80–1.00 on 7 of its 8 urgent misses, then scored confidence 0.55–0.60 and missed the bar (`packages/api/eval/README.md`). A stronger model is penalised for being cautious. |
| The synthetic gate set does not transfer. | `gpt-5.4` scored 56/56 on the gate set but 84.9% on 53 real mails, below `gemini-2.5-flash` at 86.8%. |
| Context matters more than the model. | `gemini-2.5-flash` with sender history: 86.8%, urgent 3/4. With an empty context: 77.4%, urgent **0/4**. |
| There is no behavioural ground truth. | `stampDecisionOutcome` (`judge/decision-label.ts`) has no callers. Over 90 days: 1 override and 0 opens/replies recorded. |
| One axis is folding four questions into one. | Prod, last 30 days, 2,376 mails: SILENT 57.3%, QUEUE 38.2% (unranked, ~30/day), INFO 3.1%, MEETING 1.1%, PUSH 0.4%. MEETING-first precedence produced the LinkedIn misroute (#1497). |
| Our worst outages were not about intelligence. | 2026-09-05 → 10-02: no LLM call succeeded (credits), so every mail went to the keyword fallback. 2026-10-16 → 18: budget drains (#1487, #1517). |

## 2. Principles: what keeps this right as models and sources change

1. **Models extract facts with evidence. Policy never reads a calibrated probability.** Swapping a model means re-running the fact eval. No threshold gets retuned.
2. **Relationship comes from data, not from the model.** Who the user writes to, how fast they reply, how recently, same organisation, pinned.
3. **Importance is learned per user from behaviour.** The cold start uses the relationship layer.
4. **Policy is deterministic, versioned and explainable.** Every lane decision cites the facts and the policy version that produced it.
5. **Attention is budgeted.** PUSH is the day's top-k under an interrupt budget, not whatever clears a threshold.
6. **Every decision is replayable.** Store facts, relationship snapshot, policy version and outcome. A policy change re-runs offline over stored facts, with no new LLM calls.
7. **Provider-agnostic and privacy-bounded.** The fact schema is the contract for cloud providers, BYOK, self-host (`openai-compat`) and future on-device models (Apple FoundationModels guided generation maps onto a typed schema). Any processor that sees user mail must pass the Google Limited Use check and be disclosed (see the #1543 disclosure guard).
8. **Source-agnostic.** The same fact schema covers mail now and calendar, drive and chat items later. `AttentionItem` is already multi-source.
9. **Never worse than today when the model is down.** Deterministic pre-facts plus keyword facts must reproduce at least today's keyword-fallback lanes.

## 3. Architecture

```
mail ──► (1) FACTS ─────────────┐
          deterministic pre-facts│
          + LLM facts w/ evidence├─► (4) POLICY ──► lane view (5 lanes)
(2) RELATIONSHIP (data) ────────┤     versioned    ├─► QUEUE ranking (Today list)
(3) IMPORTANCE (per-user model) ┘     + budget     └─► PUSH (interrupt budget)
                                   ▲
outcomes (open/reply/dismiss/override) ──► feed (3), measure everything
```

### (1) Facts: schema v1 (`factsVersion: 1`)

| Field | Type | Notes |
|---|---|---|
| `asks` | `Array<{ kind: "reply" \| "decide" \| "pay" \| "attend" \| "review" \| "provide", object: string, due: ISO8601 \| null, evidence: string }>` | Requests addressed to the user. `evidence` is a verbatim quote from the mail. |
| `addressedTo` | `"me_direct" \| "me_cc" \| "group" \| "bulk"` | Deterministic first (headers, List-Unsubscribe, list ids); LLM only fills gaps. |
| `threadTurn` | `"mine_to_reply" \| "theirs" \| "none"` | From thread state and SentMessage. |
| `event` | `{ proposedTimes: ISO8601[], hasInvite: boolean, conflict: boolean \| null } \| null` | ICS or invite headers are deterministic; conflict comes from the calendar read. |
| `transaction` | `{ kind: "receipt" \| "invoice" \| "shipping" \| "code" \| "statement", actionRequired: boolean } \| null` | |
| `risk` | `Array<"payment_failed" \| "security_alert" \| "account_change" \| "phishing_suspect">` | |
| `kind` | `"personal" \| "work_thread" \| "notification" \| "newsletter" \| "promotion" \| "receipt" \| "meeting"` | One primary kind. Chips and digest grouping use it. |
| `ambiguous` | `boolean` | The model says it could not decide. Triggers escalation. |

Rules:
- Every `evidence` string must be a substring of the normalised mail body or subject. If the check fails, the fact is dropped and the item is escalated.
- No free-form scores. Dates are absolute and computed against the mail's own Date header.
- Deterministic pre-facts win when certain: Gmail category, ICS invite, List-Unsubscribe, automated sender, spam label.
- Facts are persisted per item with `factsVersion`, `model`, `provider` and `extractedAt`.

### (2) Relationship: no LLM

Build on what exists: `SentMessage` (user's sent mail), `ContactEngagementScore` (outbound/dismiss counts), `learning/interaction-graph.ts` (frequency, recency, calendar co-attendance) and sender pins (`SenderLabel`). Features per sender:
- times the user wrote to them;
- last time the user wrote;
- median reply latency;
- same organisation domain;
- calendar co-attendance in the next 14 days;
- pinned or VIP;
- dismiss count.

Output is a `relationship` snapshot stored with the decision. This removes the cold-start "urgent 0/4" problem from day one, because sent mail is already synced for "waiting on".

### (3) Importance: per user, learned

Signals come from the outcomes being wired in P0: opened (and latency), replied (and latency), starred, archived unread, dismissed, lane override.

Model: a per-user logistic regression over (facts, relationship, time) features, shrunk toward a global prior. The global prior is fitted on aggregate features only, never content. It is retrained nightly on the API's CPU. Until a user has enough outcomes, the relationship layer stands in.

### (4) Policy: deterministic, `policyVersion`

- **PUSH** = (`asks` non-empty with `due` ≤ 24h) OR (`risk` contains payment_failed or security_alert). AND `addressedTo` is me_direct/me_cc. AND importance is within the user's top-k for the day. AND the item falls within the **interrupt budget**: the most PUSH notifications Klorn may send per day. **Default 5 per day, user-adjustable** (founder decision 2026-10-31). Once the day's budget is used, further qualifying items go to the top of the ranked QUEUE with the reason "held: daily interrupt budget" and no notification.
- **MEETING** = `event` present and not bulk. The calendar conflict is shown.
- **QUEUE** = `asks` non-empty, or `kind` personal/work_thread, or `threadTurn` = mine_to_reply. **Ranked** by importance × deadline proximity. This is the Today list.
- **INFO** = `transaction` without `actionRequired`, or `kind` notification without asks.
- **SILENT** = `addressedTo` bulk with no asks, or `kind` newsletter/promotion with no asks.

Pins and manual overrides keep their precedence, as they do today. Every decision stores `policyVersion` and the facts it read.

## 4. Models

- **Primary:** the cheapest model that passes the **fact** eval in the configured provider order. After the #1543 Render flip that is Claude Haiku 5.5; until then `gemini-2.5-flash`.
- **Escalation:** the best available frontier model (Opus 5.5 / Fable 5.1 class) handles only:
  - an evidence check that failed;
  - `ambiguous`;
  - PUSH candidates (high stakes).

  There is **no fixed escalation share and no monthly cost ceiling for now**: accuracy first. The founder decided this on 2026-10-31. Cost grows with users either way, and the user count is small today. Escalate wherever it measurably improves accuracy. Cost per day stays a reported metric (§5), so the trade-off is visible when the user count grows. The existing dial (`judge-dial.ts`) is the hook.
- **Self-consistency** (two samples) for PUSH candidates only.
- **Cost controls:** prompt caching for the fixed system prompt, and the provider batch API for backfills. Measured today: one Haiku judge call ≈ $0.0002.
- **Later (P5):**
  - an embedding first pass, so bulk and transactional mail (most of SILENT/INFO) skips the LLM;
  - distillation of frontier labels into it.

## 5. Evaluation

- **Fact eval set:**
  - synthetic edge cases, in the repo, PII-free;
  - the founder's own real mail, labelled at fact level. **Consent given 2026-10-31**, on condition that the labels are exact. Protocol:
    - two different frontier models label each mail independently;
    - every disagreement, and every PUSH/MEETING-relevant item, goes to the founder for review;
    - only the reconciled label counts.
    
    The labels are kept out of the repo, under `~/klorn-secrets`, and processed only by disclosed processors.
  - Metrics: per-field precision/recall, evidence validity rate, date accuracy.
- **Policy replay:** any `policyVersion` change is replayed over stored facts and diffed per lane before it ships.
- **Shadow mode:** v3 runs beside v2 on every new mail. Both results are stored, and a disagreement report is produced. Users see only v2.
- **Prod outcome metrics (the real score):**
  - PUSH acted on within 4h;
  - PUSH per day vs budget;
  - SILENT later-opened rate (misses);
  - QUEUE ranking quality vs actual reply order (NDCG);
  - keyword-fallback rate;
  - escalation rate;
  - cost per day.
- **Model upgrade procedure:** run the fact eval on the candidate, compare, flip the provider order. No threshold work.

## 6. Phases

Each phase is its own PR(s), flag-OFF, with full gate and reviews.

| Phase | Scope | Done when | Flag |
|---|---|---|---|
| P0 | Outcome stamping (in progress) and exposing the relationship features from existing tables | per-lane open/reply data accumulates; relationship snapshot available to the judge | none (measurement) |
| P1 | Re-benchmark **current** models (Haiku/Sonnet/Opus 5.5, Fable 5.1, current Gemini/GPT available to us) × {v2 score prompt, v3 fact prompt} on the gate set + real set | numbers answer whether v2 is calibration-coupled and whether v3 narrows the spread between models | none (eval only, synthetic/consented data) |
| P2 | Fact extractor (schema v1) + evidence verification + persistence, run in **shadow** | fact eval ≥ the agreed bar; shadow running on prod with a disagreement report | `JUDGE_V3_SHADOW` |
| P3 | Policy v3 (lanes from facts) + QUEUE ranking + PUSH interrupt budget | replay and shadow show v3 ≥ v2 on outcome metrics | `JUDGE_V3_POLICY` (founder flip) |
| P4 | Escalation to frontier for hard/high-stakes items + batch backfills | escalation measurably raises accuracy on the fact eval; cost per day reported (no cap for now) | `JUDGE_V3_ESCALATION` |
| P5 | Per-user importance model + embedding first pass | enough outcomes per user; first pass agrees with LLM facts on bulk/transactional | `JUDGE_V3_IMPORTANCE` |
| Review | Lane set review with 2–4 weeks of P3 data (e.g. MEETING/INFO as chips?) | founder decision (lanes are LOCKED) | — |

## 7. Kill switches and rollback

- Each flag OFF returns to v2 exactly.
- Shadow writes never change what users see.
- A policy flip is reversible because v2 decisions keep being computed until v3 has been the default for two weeks.
- Fact persistence is additive (new columns/table). No v2 data is rewritten.

## 8. Founder decisions

Decided 2026-10-31:
- PUSH interrupt budget: **user-adjustable, default 5 per day**.
- Labelling the founder's own mail for the fact eval: **yes, labels must be exact** (protocol in §5).
- Escalation: **accuracy first; no escalation share or cost ceiling for now**. Cost is tracked, not capped.

Original open list, kept for history:

1. Default PUSH interrupt budget (proposal: 3/day).
2. Consent to label the founder's own mail for the fact eval set (kept outside the repo, processed only by disclosed processors).
3. Escalation model and a monthly cost ceiling inside the $100 credit.
