# Tier Ontology v2 — analysis and proposal

Status: PROPOSAL — awaiting founder decision (2026-08-15). Implementation is
flag-OFF regardless of the option chosen.

Founder directive (2026-08-15): AUTO is redefined to include sending replies
("auto 모드"), a "기본 모드" (notify only for important mail + calendar) is
required, and the 4-tier set itself must be re-examined — 5~6 tiers allowed if
they genuinely help.

## 1. What the 4 tiers actually are today (verified against code)

| Tier | Assignment (deterministic rule over 4 LLM features) | Behavior today |
|---|---|---|
| PUSH | urgency ≥.7 ∧ confidence ≥.7 | the ONLY tier that notifies (`email-firewall.ts:335`); phone escalation; never ages |
| QUEUE | default + low-confidence fallback | visible, batched; ages 30d |
| SILENT | marketing fast-path or senderTrust<.2 ∧ urgency<.2 ∧ reversibility>.9 | auto-mark-read (marketing only); ages 14d |
| AUTO | reversibility ≥.85 ∧ confidence ≥.85 ∧ urgency<.5 ∧ senderTrust ≥.5 | **inert**: no notify, no action, never ages, unreachable by user override (web pills, Telegram buttons and sender priors all exclude it); keyword fallback has 0% AUTO recall; web copy already over-promises ("ran these without interrupting you" — nothing runs) |

The tier is a String column (not a DB enum); exactly one line couples
tier→notification and one couples tier→auto-read. Thresholds are data
(`TIER_THRESHOLDS` + ontology overrides). Cheap to change; the cost is in the
~15 consumer sites (contract Record<Tier,…>, web board columns, Swift enum,
eval floors, keyword fallback, prompt wording).

## 2. Where the 4-tier carve fails (observed, not theoretical)

1. **QUEUE is a grab-bag.** Receipts, security alerts, CI notices
   (senderTrust 0.3 class — "stay visible, NOT marketing" per the judge
   prompt) share a lane with real correspondence that needs a human reply.
   This is the main driver of "inbox가 뭔지 모르겠다": the one lane the user
   is told to review mixes must-answer mail with never-answer records.
2. **Meeting mail has no home.** "A scheduled date alone is NOT urgency"
   (prompt), so invites land in PUSH or QUEUE depending on scored urgency —
   yet they are the one class with structured actions (accept/decline/
   propose), a hard deadline, and calendar cross-reference (already built:
   meeting-context module, reply-options accept/decline/info, D3). The
   founder's 기본 모드 definition explicitly names 일정 as notify-worthy.
3. **AUTO conflates taxonomy with delegation.** "What is this mail" (a
   routine, low-risk, answerable message) is a property of the mail; "may
   Klorn answer it unattended" is a property of the USER's trust setting.
   Baking delegation into the classifier means the same mail is classified
   differently depending on a policy question the classifier shouldn't own —
   and it leaves AUTO unreachable by user override today.

## 3. Proposal (recommended): 5 tiers + eligibility flag + account mode

**Tiers = what the mail is. Mode = what Klorn may do. Flag = per-item safety.**

| Tier (ko) | Definition | Notify (기본) | Notify (auto) | Ages |
|---|---|---|---|---|
| PUSH (즉시) | needs a human within hours | ✅ | ✅ | never |
| MEETING (일정) | scheduling: invite/reschedule/confirm — structured accept/decline + conflict check | ✅ | ✅ | at event time |
| QUEUE (검토) | human should read; reply likely | ❌ | ❌ | 30d |
| INFO (기록) | transactional record — receipts, alerts, confirmations; no reply ever expected | ❌ | ❌ | 14d |
| SILENT (차단) | bulk marketing; auto-mark-read | ❌ | ❌ | 14d |

- **`autoEligible` flag** (the old AUTO rule: reversibility ≥.85 ∧ confidence
  ≥.85 ∧ senderTrust ≥.5) computed on QUEUE and MEETING items.
- **Account mode** `attentionMode: BASIC | AUTO` (new, desktop-settable):
  - BASIC: current behavior — autoEligible items show a one-click "보내기"
    suggested reply (draft pre-generated).
  - AUTO: autoEligible items are answered automatically via the EXISTING
    gated send primitive (`sendAutoReplyViaFloor` + ActionReceipt +
    ActionOutbox — no new send path), following the 답장 기본 지침; a
    notification-free record lands in the ledger; PUSH/MEETING still notify.
- **답장 기본 지침**: `AutomationConfig.autoReplyGuideline` (text). Unset →
  founder-authored default (draft below, needs founder wording approval):
  > 항상 공손하고 간결하게. 약속·금액·기한은 확정하지 말고 "확인 후
  > 회신드리겠습니다"로 유보. 받은 메일 언어로 답장. 서명 이외의 개인정보
  > 언급 금지.
- Tones: backend already has 4 (MATCH_ME/FORMAL/FRIENDLY/CASUAL) — matches
  founder's 업무/공손/캐주얼 + 내 문체 with label changes only. No schema work.

Why not 6 with AUTO kept as a tier: an auto-answered item is still, by
content, a QUEUE or MEETING item; keeping AUTO as a lane forces every
consumer to answer "is this a category or a permission?" differently (which
is exactly today's incoherence — cf. §2.3).

## 4. Alternative (smaller): keep 4 + MEETING + INFO = 6 tiers

Keep AUTO as-is and give it the send behavior under mode=AUTO. Less
conceptual cleanup, same migration surface for MEETING/INFO. Rejected as
recommendation because it preserves §2.3, but listed since the founder said
5–6 is acceptable.

## 5. Migration & rollout (either option)

1. Contract + `TIERS` + `normalizeTier` (legacy AUTO rows → QUEUE +
   `autoEligible=true` under option 3), Swift enum, web board lanes.
2. Judge: MEETING/INFO branches in `tierFromFeatures` (+ one new LLM feature
   `isScheduling`/`isTransactional` or reuse sender-trust 0.3 band + meeting
   parser signal already computed in meeting-context).
3. Eval floors per new tier BEFORE enabling (keyword fallback needs MEETING/
   INFO recall paths; current fallback has 0% AUTO recall — do not repeat).
4. Flags: `TIER_V2_ENABLED` (classification), `AUTO_MODE_SEND_ENABLED`
   (send), both OFF. Flip = separate founder decisions.
5. Copy: 4-tier marketing ontology (writing-style rule) is superseded by this
   founder decision — landing/product copy updates ride the flip, not the
   merge.

## 6. What this does NOT change

- PUSH notification path, dedup, quiet hours, rate limits — untouched.
- EmailRule AUTO_REPLY (user-configured canned rules) — separate feature,
  stays.
- Agent SHADOW/SUGGEST/AUTO modes — orthogonal (tool risk gating), stays.
