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
- Deterministic pre-facts win when certain: Gmail category, ICS invite, List-Unsubscribe, automated sender. The spam label is a signal, not a fact (see conventions below).
- Facts are persisted per item with `factsVersion`, `model`, `provider` and `extractedAt`.

#### Facts v1 conventions (P2, agreed with the P1 benchmark so numbers stay comparable)

Code: `packages/api/src/judge/v3/` (`facts-schema.ts` is the canonical type and validator; `evidence.ts` holds the normalisation and the time tokens; the P1 scorer mirrors them).

- **Haystack.** Evidence is checked against every text field shown to the model, each field separately (a quote cannot span subject and body), using the text *as shown* (after truncation), not the stored body.
- **Normalisation.** NFKC, strip every Unicode format character (`\p{Cf}`: zero-width, soft hyphen, bidi overrides), controls to spaces, fold curly quotes and dashes, collapse whitespace, trim, lower-case. Case-insensitive on purpose: a re-capitalised sentence start must not drop a real ask.
- **Minimum quote.** At least 2 tokens, or at least 8 characters as one token (Korean phrases often have no spaces); at most 300. A stray "the" cannot ground a fact. A quote may not cut a Latin word ("approval" does not verify inside "disapproval"); scripts that attach particles to words (Korean) are not boundary-checked.
- **Due binding.** An ask with a non-null `due` must have evidence that states a time (`TEMPORAL_RE`): a time-shaped number (6pm, 18:00, 3/5, 2026-11-03, 5th, within 3 hours, 6시, 3일), a weekday or month name (ambiguous short forms such as "may", "sun", "wed" only next to a number), today/tomorrow/tonight/EOD/EOW/COB/end of day/close of business/deadline/ASAP/urgent/immediately/morning/noon…, or 오늘/내일/모레/이번 주/다음 주/…요일/오전/오후/까지/마감/기한/긴급/즉시/당장. Otherwise `due` is cleared, the ask is kept, and the item escalates. The prompt tells the model to quote the deadline words. The due value itself is not compared with the quote, so policy still treats a due as model-derived.
- **Relative dates**, resolved against the mail's sent time in its own offset:
  - today / EOD / end of day / tonight → 23:59 that day;
  - tomorrow → 23:59 the next day; tomorrow morning → 09:00; tomorrow noon → 12:00;
  - within N hours → sent time + N hours;
  - a weekday → 23:59 on the next such day on or after the sent day;
  - ASAP / urgent / right now / immediately → the sent time itself;
  - a meeting start is not a due date unless the mail asks for action by then;
  - no zone given → the sent time's offset (else the user's timezone).
- **Date validity.** ISO-8601 with an explicit offset only; a date more than 60 days before or 400 days after the mail is dropped as a misreading.
- **The Date header is mail-controlled.** Only its parsed value (a local time with offset, and only when it is within 2 days of receipt) reaches the prompt, never its text. RFC 5322 allows comments in it.
- **Invites.** Only an attached calendar file (text/calendar, `.ics`) sets `event.hasInvite`. Mail text cannot: an "Invitation: … @ …" subject, or the model reading one, is attacker-writable. `event.conflict` is null until the calendar read lands.
- **Spam label.** It fixes no fact field, because Gmail misfiles real mail and SPAM_INTAKE exists to rescue it. It travels as the header signal `spam`, and policy keeps spam out of PUSH and MEETING.
- **Header signals.** The detector results (list mail, automated sender, spam, Gmail category, calendar file, recipient counts and position) are stored with the facts. They are booleans and counts, never mail text, and replay can read them.
- **What the model sees.** Mail fields are wrapped as untrusted. Invisible format characters (zero-width, bidi, Unicode tag characters) are dropped first. Recipients go as counts, never third-party addresses.
- **Relayed asks.** A system notification that relays a person's request or assignment ("X assigned you issue Y", "X requested your review") is an ask, quoting the relayed words.
- **No LLM answer.** The extractor stores no facts (`factsSource = "none"`), only the certain pre-facts and the signals. The keyword fallback belongs to the policy layer (P3 `keywordFactsV1`), which owns parity with today's keyword lanes.

Open for facts v1.1 (not changed here): `risk` and `transaction.actionRequired` carry no evidence. A mail can claim `security_alert` without a quote, so policy v3 must not let risk alone interrupt without another signal. A `riskEvidence` field is the proposed fix.

### (2) Relationship: no LLM

Build on what exists: `SentMessage` (user's sent mail), `ContactEngagementScore` (outbound/dismiss counts), `learning/interaction-graph.ts` (frequency, recency, calendar co-attendance), sender pins (`EmailRule` `PIN_TIER`) and sender labels (`SenderLabel`). Features per sender:
- times the user wrote to them;
- last time the user wrote;
- median reply latency;
- same organisation domain;
- calendar co-attendance in the next 14 days;
- pinned or VIP;
- dismiss count.

Output is a `relationship` snapshot stored with the decision. It eases the cold-start "urgent 0/4" problem from day one, because sent mail is already synced for "waiting on". The sync reads only the newest page of the Sent folder (50 mails) every 30 minutes. Without history, the snapshot sees at most the user's last 50 sent mails, and older correspondents look new. Production on 2026-10-31: 192 `SentMessage` rows across 3 users, the oldest from 2026-06-04.

A one-time history import (`mail/sent-history-import.ts`, flag `SENT_HISTORY_BACKFILL_ENABLED`, OFF by default, accepts `cohort`) fills that in:
- Scope: the newest 2,000 sent mails of the last 12 months, for each inbox the scan reads (primary Gmail and linked Google inboxes not waiting for a reconnect). Headers only (`format=metadata`: To, Subject, Date, with a field mask, so no snippet). `To` and `Subject` are stored up to 1,024 characters. No new scope.
- Resume: each run lists the window's ids and fetches the oldest ones `SentMessage` does not have, so the rows are the progress. A crash or redeploy resumes, and gaps the scan left are filled.
- Pace: at most 100 metadata fetches per user per email-sync tick, 2 in flight, at most 10 list pages and 2 minutes per run, run detached from the serial user loop.
- Failures: a transient failure (429, 5xx, timeout, auth, a failing listing) pauses only that inbox for 30 minutes, counts nothing, and keeps everything newer than it for later. A message that fails for good 3 times (another 4xx, no usable date, a write Postgres rejects) is skipped; the inbox can finish without it. When no inbox can run, the user waits 30 minutes.
- Done: when every listed mail is recorded, the grant row (`UserToken` / `LinkedInboxAccount`) gets `sentHistoryImportedAt` and the inbox is not listed again. A reconnect or re-link resets it, since it may be another Google account.
- Provenance: rows the import or the scan create are labelled at insert by `mail/sent-origin-classifier.ts`, with the legacy backfill's rules and its own mailto derivation; a Postgres test (`sent-origin-parity-pg.test.ts`) checks both give the same labels. Two differences: among rows with the same `sentAt`, a recorded row counts as earlier, then gmailId order (the SQL compares random ids); and a subject over 1,024 characters, stored truncated, is compared with the source or mailto subject truncated the same way, so it still matches (the SQL compares it with the untruncated text, so it never does). A label recorded at send time is never overwritten. If the labels cannot be read, the scan writes only rows it already had.

As built in P2 (`judge/v3/relationship.ts`, `relationship-loader.ts`):
- Every field is null when the data to answer it does not exist, never 0, so policy can tell "unknown" from "never". No sent-mail sync means the sent fields are null.
- "Wrote to them" matches the exact address on the To header.
- Reply latency is measured per thread, from the sender's earliest unanswered mail to the user's reply. Gaps over 30 days are ignored.
- Same organisation means a shared domain that is not a public mailbox provider, **and** this mail passed DMARC (the receiving server's Authentication-Results, or the Klorn mailbox's stored verdict). Unauthenticated same-domain mail is null, because a lookalike or spoofed colleague must not be lifted (CEO fraud).
- Reciprocity and tenure, as raw counts (smoothing and weights belong to the per-user importance model, never to the snapshot):
  - `inboundCount`;
  - `inboundThreadCount` and `repliedThreadCount` (threads where the user wrote after the sender's first mail; a 1/1 is not "100%");
  - `userInitiatedThreadCount` (the user's mail opens the thread);
  - `firstSeenAt` (first contact either way).
- A From with no parseable mailbox gives an all-null snapshot.
- Per-user ego network only: one user's mail never informs another user's snapshot. No hand-tuned scores (the interaction graph's are not reused).
- Sent provenance (#1591): `SentMessage.origin` records who sent each mail.

  | Value | Meaning | Relationship evidence |
  |---|---|---|
  | `user` | manual send through Klorn | yes |
  | `approved` | the agent drafted it; the user approved these exact bytes | yes |
  | `auto_reply` | an autonomous reply the user never saw | never |
  | `unsubscribe` | a mailto unsubscribe request | never |
  | null | seen only by the Sent-folder scan, with no proof that Klorn sent it (counted as the user's own mail) | yes |

  This applies to every sent-side field: sent count, last sent, reply latency, replied and user-initiated thread counts, and the sent side of `firstSeenAt`. The loader applies it as one where-clause (`SENT_EVIDENCE_WHERE`, #1589).

  Legacy rows (before #1591) were labelled on 2026-11-01 by migration `20261101000000_sent_message_origin_backfill`. It labels only from records written at send time:
  - `approved`: the executed approval's returned messageId.
  - `auto_reply`: the unattended-reply claim's recipient, an exact `Re: <subject>`, and a send within 2 minutes of the claim. Only the first such row per claim counts, and a claim rewritten as failed never counts.
  - `unsubscribe`: the recipient is a mailto List-Unsubscribe target of a mail received in the same account before the send. The subject must equal the decoded mailto subject, or be a same-shape per-mail token sent to an address that never mails the user.

  Production dry run: 4 `auto_reply` and 37 `unsubscribe` of 192 rows; no row qualified as `approved`. Of the 37, 28 match the subject exactly and 9 are token subjects. One row from before the send floor (2026-06-04 10:22 UTC) is unprovable and stays null. A sent-history import must classify the rows it creates with the same rules.
- Pinned means any `PIN_TIER` rule on the address or domain. VIP means a sender label of investor or customer, or a pin to PUSH.
- **Calendar co-attendance comes from the co-attendance store below, past meetings only** (`judge/v3/relationship-coattendance.ts`).
  - The snapshot carries `meetingCount`, `smallMeetingCount`, `lastMetAt` (a UTC day), and the window the counts cover: `coAttendanceObservedSince` (the latest `coAttendanceObservedSince` across the user's Google calendar sources) and `coAttendanceCountedThrough` (the watermark). Raw values, no weights.
  - All five are null unless the reader's gate below passes. Then a missing row is 0, 0 and a null `lastMetAt`. When the gate fails they are null even if a row exists, because its counts may be incomplete.
  - The count covers at least that window. It may also hold older meetings, because a row is never pruned when coverage restarts (a re-link, a reconnect, a gap).
  - `coAttendanceNext14d` is **deprecated and always null**, because no upcoming attendee data is stored. It stays in the shape so stored rows replay unchanged. A stored snapshot written before these fields existed reads them as null (`parseRelationshipSnapshot`).
  - The interaction graph's "meeting" count is inferred from email volume, which is not co-attendance, so it is not reused.

Co-attendance store (`pim/coattendance/`, behind `CALENDAR_COATTENDANCE_ENABLED`, off by default). Founder decision 2026-11-01: keep per-contact counts, never attendee lists.

- **Counts.** `ContactCoAttendance` has one row per (userId, contactEmail) with raw counts, no weights: `meetingCount` (ended meetings the user took part in, with the contact invited and not declining), `smallMeetingCount` (of those, at most 5 such people; rooms and decliners excluded), `firstMetAt` and `lastMetAt` (the UTC day the earliest and latest counted meeting ended). It counts past meetings; the "next 14 days" feature above is not served by it. No column of it or of `CoAttendanceMeeting` (a SHA-256 of each counted meeting's identity and its end day, kept about a month so a meeting in two of the user's calendars counts once) is finer than a UTC day or records when a row was written.
- **One pass per user, each finished UTC day once.** A background job the scheduler queues (never a request, never inside a user's per-tick budget) lists every Google calendar source of the user together (the primary, and each GOOGLE linked calendar not awaiting a re-link while linked sync is on): the days after the user's watermark `User.coAttendanceCountedThrough` through yesterday (the first pass, and the first after a data wipe, which resets the watermark: the last 30 days). The watermark's contract: every finished UTC day up to and including it has been evaluated for every included source. All sources' meetings that ended on one UTC day are written in one transaction, so rows that share a Postgres transaction id (`xmin`) reveal no more than `lastMetAt` already does. Only a day over a cap (25 meetings or 200 distinct contacts) is split, into the fewest balanced slices in marker-key order (26 meetings: 13 + 13), so each part is a key-ordered slice of that day and never one meeting alone. Each day transaction takes a per-user advisory lock and re-reads the day's markers: a one-slice day that has any is complete and skipped; a split day is resumed, writing only its unmarked meetings. The watermark advances (compare-and-swap; a pass that loses it stops) only through the last day every source listed in full (a cut listing counts through the day before its last listed start; a failed one covers nothing). A day at or before the watermark is never evaluated again.
- **Counting rules.** A meeting counts once its whole UTC end-day has finished, if it is not cancelled or all-day, has at most 50 invitees with a complete guest list, and the user organised, accepted or is tentative; an event without the user's entry counts only if the calendar says they organised it. Rooms Google flags as resources, the user's own addresses and anyone who declined are never counted.
- **Coverage, per source** (on `UserToken` for the primary, on `LinkedCalendarAccount` for a linked calendar): `coAttendanceObservedSince` is the first full day the source was covered by an advance of the watermark (a newly linked source: the day after the watermark); a source left out of an advance loses it, and after a gap (the watermark older than the day before the window) coverage restarts at the window's first day for every source. `coAttendanceLastPassAt` is written on every pass in which that source's own listing succeeded in full through the days being evaluated, whether the watermark advanced or there was nothing new to count in them, and never for a failed or cut listing. A pass that finds no new day to evaluate lists nothing and writes nothing; a new day appears every day, so a running job refreshes it daily. Reconnecting or re-linking clears both.
- **The reader's gate (P2's contract).** A missing `ContactCoAttendance` row means 0 only when ALL of these hold; otherwise every co-attendance field is null:
  1. the flag is ON;
  2. `User.coAttendanceCountedThrough` ≥ utcDay(now) − 2 days;
  3. the user has at least one Google calendar source, and EVERY one (the primary `UserToken`, provider google, and each `LinkedCalendarAccount` with provider GOOGLE, as the store's own `readCoverage` lists them) has `coAttendanceObservedSince` ≤ utcDay(now) − 30 days, that is full-window coverage; a source that joins later reads null for up to 30 days;
  4. no Google source has `needsReconnect`;
  5. the user has NO non-Google calendar source (a `LinkedCalendarAccount` of Outlook, CalDAV or any other provider);
  6. the sender's address can be normalised, and it is not one of the user's own addresses as the store knows them (`loadOwnAddresses`, shared by writer and reader: the account email, each Google login's address, every linked calendar and inbox), since the store never counts those.

  The window the counts cover, for P5, is [max over sources of `coAttendanceObservedSince`, `coAttendanceCountedThrough`]; the snapshot carries both ends. Freshness is the watermark's (condition 2); a source's `coAttendanceLastPassAt` is not read, because a failing source freezes the watermark while the other sources' pass times stay fresh (probe C).

  False zeros this gate prevents:
  - a source that joined later (probe A): its earlier meetings were never counted, so its contacts would read 0 although the user met them (condition 3);
  - a stale watermark (probe C): the job stopped (flag flipped off and on, scheduler down, a source failing) and the days since were never evaluated, so recent meetings would read 0 (condition 2);
  - non-Google calendars: Outlook and CalDAV meetings are not counted at all, so their contacts would read 0 (condition 5); a re-link-pending Google source is not being listed (condition 4).
- **Known limits.** A late accept or guest change after a meeting's day was evaluated is ignored (recall loss: written on its own, it would show its guest list through `xmin`); a meeting is counted again if its iCalUID changes (re-imported or recreated, or a recurring series split at "this and following") on a day not yet evaluated; one failing source holds the watermark for all of the user's sources; Outlook and CalDAV are not counted yet; rows are not removed when a calendar is unlinked or the flag is turned off (a data wipe or account deletion removes them).

Facts and the snapshot are stored in `AttentionFacts`, one row per (userId, source, sourceId), the natural key of `AttentionItem` and `DecisionLabel`. The row also holds the evidence check, escalation reasons, model, provider, and the v2 lane shown when the shadow ran. That lane is frozen there because `DecisionLabel.shownTier` is rewritten on re-judge.

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

### (5) Policy v3.0: exact rules, budget, ranking (P3)

The code is in `packages/api/src/judge/v3/`: `policy.ts`, `interrupt-budget.ts`, `push-budget-gate.ts`, `ranking.ts`, `importance.ts`, `keyword-facts.ts`, `parity.ts` and `replay.ts`. Every decision carries `policyVersion: "v3.0"`.

**Evaluation.** The result is the lane before the budget. The first match wins:

1. A manual override, then a sender pin, sets the lane. That is the order in effect today: an overridden item is preserved against any later judgement, a pin included. In the live judge, the marketing fast-path, sender priors and learned rules still short-circuit before facts, as in v2. Replay keeps the v2 lane for those items.
2. **MEETING**: `event` is present and `addressedTo` is not bulk. This is checked before PUSH, as in v2. A meeting notifies through its own lane and spends no interrupt budget.
3. **PUSH candidate**: `addressedTo` is me_direct or me_cc, there is no `phishing_suspect`, and one of these holds:
   - `risk` contains payment_failed or security_alert, and the sender is a **VIP** (an investor/customer label, or a sender pinned to PUSH). Risk has no evidence quote in facts v1, so on its own it needs relationship trust.
     - A VIP whose From failed DMARC (`senderAuthenticated` false) is not trusted. VIP labels match by address or domain, which a forger can copy. No verdict (null) is not a failure: some providers report none.
     - The same organisation is not enough: that is how CEO-fraud spoofing looks.
     - "The user wrote to them" is not enough either. `SentMessage.origin` (#1591) now marks Klorn's own sends, but rows recorded before it stay null and still read as the user's (§3(2)). A past unattended auto-reply to an attacker could therefore still lend trust.
     - v2 never pushed machine mail, so this is never worse than today. A user who wants a bank's alerts to interrupt pins the sender to PUSH.
   - An ask has `due` within 24h of the decision time, either side. An ask overdue by more than 24h is stale: it ranks at the top of QUEUE but does not interrupt, and a re-judge of old mail cannot turn it into a PUSH. Also, `kind` must not be notification, newsletter, promotion or receipt, and the deterministic automated-sender signal must be off. Machine mail interrupts only through `risk`. This keeps the v2 automated-sender PUSH floor (#794), and it does not depend on the model's `kind`.
4. **QUEUE**: a payment/security risk that did not PUSH (also under a phishing suspicion, so a false positive is never filed or hidden), non-empty `asks`, `threadTurn` mine_to_reply, `transaction.actionRequired`, or `kind` personal or work_thread.
5. **INFO**: `transaction` is present, or `kind` is notification or receipt.
6. **SILENT**: `addressedTo` is bulk, or `kind` is newsletter or promotion.
7. Otherwise **QUEUE**, the default lane.

Floors:
- `ambiguous` never lands in SILENT or INFO. It goes to QUEUE, like v2's low-confidence rule.
- Mail that Gmail marked as spam never lands in PUSH or MEETING. It goes to QUEUE, like v2's spam floor. `spam` and `automatedSender` are mailbox signals passed next to the facts; they are not facts.
- `phishing_suspect` never lands in PUSH or MEETING (a suspected fake invite goes to QUEUE) and shows up as a reason on any lane.

**Live decision (P3 PR2).** For a user under the policy (see Flags), the judge decides the lane, including a budget hold, before it writes the item:
1. The v2 judge runs as today. A precedence source (manual override, sender pin, marketing fast-path, sender prior, learned rule) keeps its v2 lane, and the item records the matching reason.
2. Otherwise, new mail gets facts from the live extractor (`v3/live-facts.ts`, P2). This is the judge's own call, not the sampled shadow:
   - it waits for a model slot;
   - it uses the user's own key when one is set;
   - it has a 20s deadline.

   A re-judge or the backfill sweep reads the stored facts (`AttentionFacts`) and makes no model call.
3. With LLM facts, policy v3.0 decides. With no LLM facts, the v2 lane stands: it is the better evidence we have. That covers an extractor failure, the deadline, a budget refusal, and no stored row. The exception is when the v2 judge itself fell back to keywords. Then keyword facts merged with the certain pre-facts decide (fallback parity, below).
4. A PUSH then passes the push gates: the 6h rule, the re-ingest skip and the dedupe. If it is not pinned and would ring, it claims a budget slot **before** the item is written. A held PUSH is written as QUEUE with `heldAt`, so it never shows as PUSH, not even for one sync.
5. The item stores what ranking and clients read:
   - `v3PolicyVersion`: "v3.0", or "v2" when the v2 lane stood;
   - `v3Decision`: `{ basis: "llm" | "keyword" | "v2", reasons, threadTurn }`;
   - `v3Due`;
   - `v3Importance`;
   - `heldAt`.

   When the policy picks a different lane from v2, `tierReason` becomes the static key `email.v3LaneFromFacts`, because v2's text would not explain the new lane. Otherwise v2's reason stays.
6. A hold is final for the item. A later re-judge that says PUSH again keeps it in QUEUE, held; it is past the 6h push window by then. A pin keeps precedence over a hold, and a re-judge to any other lane clears it.
7. If a human or an agent moved the item while the judge ran, their lane stands. A slot already claimed for it stays spent, and its bell row is hidden.
8. Failure paths:
   - If planning fails (a database error), the mail is still written, in the v2 lane, with no v3 columns and no PUSH notification. The budget is never bypassed. MEETING still rings, since it is not budgeted.
   - If writing the item fails after a slot was claimed, the claim is released. Nothing rang, so the backfill sweep's retry can claim and ring again.
   - The backfill sweep leaves a policy user's mail younger than five minutes to the inline judge, so the two never claim slots for the same mail at once.
9. v2's `autoEligible` (unattended auto mode) survives only where v3 kept v2's lane and saw no payment, security or phishing risk.

**Interrupt budget.** The founder's default is 5 per day (§8). `JUDGE_V3_PUSH_BUDGET` sets the system default and accepts a positive integer or `unlimited`. `AutomationConfig.interruptBudget` (1–50, via `PATCH /api/automations`) overrides it per user. Null means the system default. Any other value is a 400. For a user under the policy, the automations response adds `interruptBudget`, `interruptBudgetDefault` (null for no limit) and `interruptBudgetMax`.
- The budget is counted per user per local day (`AutomationConfig.timezone`). Only PUSH notifications spend it. MEETING does not.
- These spend nothing:
  - the existing gates, which run first: the 6h recency rule, the IMAP re-ingest skip and the 7-day dedupe (`email-firewall.ts`);
  - a push that would not ring anyway, because the user's notification preferences, quiet hours or focus block say no;
  - a sender the user pinned to PUSH. A pin is the user's own rule and keeps precedence over the budget.
- Admission is atomic. A sent PUSH writes its bell row with `Notification.dedupeKey = interrupt:<YYYY-MM-DD>:<n>`, which is unique per user, so concurrent judgements cannot exceed the budget. Clearing the bell hides these rows instead of deleting them.
- A PUSH with no free slot is held:
  - lane QUEUE;
  - `tierReason` = `email.heldByInterruptBudget` ("Held: daily interrupt budget reached", 7 languages);
  - no notification;
  - `DecisionLabel.shownTier` = QUEUE. `decidedBy` keeps the judge path, because the fallback repair sweep selects on it.
  - The judge drops a model reason that equals a static reason key, so only the hold path writes the held key. Ranking trusts `AttentionItem.heldAt`, not the reason text.
  - If a human or an agent moved the item between the judgement and the hold, nothing is sent and their lane stands.
- **Slots reserved for trusted senders.** 40% of the day's slots, rounded down, are reserved for trusted senders, with at least 1 from a limit of 2 up (5 → 2, 3 → 1, 2 → 1, 1 → 0).
  - A trusted sender is a VIP, or someone the user has written to at least twice (`sentCount` ≥ 2). One reply, such as "who is this?", is not a relationship.
  - A sender whose From failed DMARC is never trusted.
  - Slots are numbered 1..limit. Strangers claim only slots above the reserve, so five urgent-looking mails from strangers can spend 3 slots at most.
  - Trusted senders claim the lowest free slot, and may also use the slots above the reserve. The reserve only limits strangers; it is not a cap on trusted senders.
  - The day's used slots are counted first, so a limit lowered mid-day still holds.
  - A budgeted PUSH decided without a relationship gets one loaded from the database, with no model call. That covers a v2 lane standing for missing facts, a sender prior and a learned rule. A failed load leaves the sender a stranger.
  - `sentCount` still counts legacy null-origin sends (§3(2)). An attacker who got two Klorn auto-replies therefore counts as trusted, and can take any free slot, not only the reserved ones. That is bounded by the limit, and it does not change the lane. With no limit there is no reserve.
- For a user under the policy, the legacy keyword urgent sweep (`automation-scheduler.ts`) stops sending its own pushes. The policy's PUSH lane, under the budget, is then the only budgeted email interrupt. MEETING still notifies outside the budget, as in v2.
  - Prod, last 30 days to 2026-10-31: 43 of the 48 "Urgent email" notifications were for mail whose firewall lane is now QUEUE or SILENT, or which has no item. That is the sweep.
  - **This is part of the founder's flip decision.**
- Live admission is first come, first served within the day, apart from the trusted reserve. "Importance within the day's top-k" applies inside a batch (replay), and gets stricter once P5 importance exists.
- A set but invalid `JUDGE_V3_PUSH_BUDGET` falls back to 5 with a warning in the log.

**Importance before P5** (`importance.ts`). A relationship prior in [0, 1]:
- a VIP scores 1;
- otherwise the score starts at 0.2 and adds:
  - sent count, on a log scale that saturates at 20;
  - recency of the last mail the user sent, with a half-life of 30 days;
  - reply latency;
  - same organisation;
  - calendar co-attendance;
- dismissals subtract from it.

Unknown (null) features add nothing. A pin adds nothing either: it sets the lane, not the importance.

**QUEUE ranking (the Today list).**
- Held items come first: by importance, then in the order they were held. That way mail from strangers that spent the budget cannot push a known sender's held alert down.
- Then items are ordered by importance × deadline proximity. Proximity rises linearly from 1 (no deadline, or one 7 or more days away) to 2 (due now or overdue). A payment/security risk that did not PUSH ranks as due now, unless phishing is suspected.
- Ties go to the newer mail.
- No numeric score is sent to clients.

**Fallback parity (principle 9).** With no LLM facts, `keywordFactsV1` derives facts from the same detectors as the v2 keyword fallback. The P2 extractor writes `factsSource: "none"` rows when the LLM fails.
- If the v2 judge also fell back to keywords, the policy uses keyword facts merged with the certain pre-facts.
- If the v2 judge had a model answer, its lane stands (live decision, step 3). A keyword lane would be worse evidence than the model lane the user gets today.

A test runs both paths over the cross product of keyword signals (4,368 mails), against the real v2 code path. It asserts:
- (a) nothing v2 shows becomes SILENT, except bulk scheduling mail;
- (b) every v2 PUSH stays a PUSH candidate, except list mail;
- (c) machine, marketing and spam mail never become PUSH candidates;
- (d) nothing becomes a PUSH candidate that v2 did not push. In keyword facts, an urgent word gives the ask a due time only where v2's keyword rule would have pushed (an investor-looking sender). Elsewhere the ask has no due time, so the model-down path never interrupts more, or for more senders, than v2 did.

The documented divergences (`parity.ts`), counted on that corpus:

| Class | Change | Why |
|---|---|---|
| bulkScheduling | MEETING → QUEUE / INFO / SILENT (449) | MEETING requires "not bulk". v2 let bulk invites into a lane that notifies (#1497). |
| machineListFiled | QUEUE → INFO (117) | Machine list mail with nothing asked is filed, and stays visible. |
| listNeverInterrupts | PUSH → QUEUE (52) | PUSH requires mail addressed to the user. |

These are cross-product counts, not prevalence. The replay reports prevalence on real mail. In prod, 331 of the 2,378 email decisions in the 30 days to 2026-10-31 came from the keyword fallback.

**Flags.**
- `JUDGE_V3_POLICY` (default OFF) applies to the users `JUDGE_V3_SHADOW` covers: `true` means everyone, `cohort` means the cohort. Other users keep v2 exactly, with no budget. This allows a cohort rollout: POLICY=true with SHADOW=cohort.
- **Cost.** For a user under the policy, the facts call is part of the judge (live decision, step 2). That is one more model call per new mail, and it replaces the sampled shadow for that user. Prod volume for scale: 2,378 email decisions in the 30 days to 2026-10-31, about 80 a day across all users.
  - The facts call draws on the judge's reserved slice of the daily cost cap (`JUDGE_BUDGET_RESERVE_CENTS`). It therefore competes with the v2 judge call for the same reserve.
  - v2 keeps being computed per mail until v3 has been the default for two weeks (§7). Until then, one new mail spends two reserved calls.
  - Before a POLICY flip, check the reserve against that double draw and raise it if needed.
- Per item, missing LLM facts mean the v2 lane (live decision, step 3).
- These apply per user, only to users under the policy:
  - the budget;
  - the legacy sweep stand-down;
  - the claim-row dedupe.

**Replay.** Run `pnpm --filter @klorn/api replay:policy -- [--user=] [--days=30] [--budget=5|unlimited] [--facts=stored|keyword] [--out=] [--show-subjects]`. It is read-only and makes no LLM calls.
- `--facts=stored`, the default, decides each item the way the live path would: stored LLM facts go to the policy, otherwise the v2 lane or the keyword parity rule applies.
- `--facts=keyword` gives every item keyword facts. That is the model-down estimate.
- For a v2 PUSH row with no stored relationship, the CLI loads the relationship from the database, as the live path does for the trusted reserve. A human's or an agent's lane is kept, as live keeps it.

It reports:
- the lane distribution: v2 shown, v3 before the budget, v3 final;
- v2 → v3 transitions;
- budget stats per user-day. Like the live path, pins and manual overrides spend no budget. Quiet hours, preferences and the 6h rule are not modelled, so `held` is an upper bound;
- keyword parity on real mail;
- per-item changes (ids by default).

**Reasons and API contract (for the surface redesign).** These fields are additive. They appear only for a user under the policy (`isJudgeV3PolicyEnabled`); everyone else keeps today's shape and order, with the new fields absent, not null.
- **Ranked QUEUE (P3 PR2b).**
  - Where it applies:
    - the QUEUE lane page, `GET /api/email?tier=QUEUE`, threads included;
    - the Reader's previous and next within that view;
    - the QUEUE lane of `GET /api/inbox/firewall`.
  - The order: held items first, by importance and then in the order they were held. Then importance × deadline proximity. Ties go to the newer mail, then the id.
  - The SQL in `judge/email-lanes.ts` and `ranking.ts` `rankQueue` (in memory, for the firewall list) are the same order. A Postgres test pins the two together.
  - An item v3 never decided ranks with importance 0.2 (the unknown prior) and no deadline.
  - A thread ranks by its newest message in the view.
  - The Reader's neighbours are picked by row number in that order. They work even after the open mail has moved out of the view.
- Each item gets `v3: { policyVersion, rank, held, due, threadTurn, reasons }`, on lane pages, firewall items and the Reader context:
  - `policyVersion` is "v3.0" when the policy decided, and "v2" when the v2 lane stood because LLM facts were missing. In that case `reasons` is empty and the existing `tierReason` explains the lane. It is null when v3 never decided the item, for example mail judged before the flip;
  - `rank` is the 1-based position in the ranked QUEUE: skip + index + 1 on a QUEUE lane page, and the index in the firewall's QUEUE lane. It is null in any other view, All included. A page of All cannot know a mail's QUEUE position without ranking the whole lane;
  - `held` is true when the budget held this PUSH and the item still shows it. That means `heldAt` is set, the lane is QUEUE, and no human or agent lane is on the item. Held items take ranks 1..n, by importance and then in the order they were held;
  - `due` is an ISO 8601 UTC timestamp. Clients format it in the display zone, and null hides the chip;
  - a human override shows `reasons: [manual_override {tier}]`. An agent lane shows no reasons.
- Stored reasons are re-validated on read:
  - an unknown code is dropped;
  - a param that is not a string, number, boolean or null is dropped;
  - evidence is capped at 300 characters, and `evidenceIn` is located against the subject.
- Each reason is `{ code, fact, evidence, evidenceIn: "subject" | "body" | null, params }`.
  - `reasons[0]` decides the lane; the rest support it. Reasons contain no prose and no model names; clients localise from `code` and `params`.
  - Codes: pinned, manual_override, sender_pattern, learned_rule, event, risk, ask_due_soon, addressed_to_me, ask, thread_turn_mine, transaction_action, kind, transaction_record, bulk, default_queue, ambiguous, spam_floor, held_budget, relationship.
  - Params by code:
    - `addressed_to_me` {addressedTo}
    - `risk` {risk, trusted}
    - `event` {conflict}
    - `ask` and `ask_due_soon` {askKind, due}
    - `kind` {kind}
    - `transaction_*` {transactionKind}
    - `held_budget` {budget}
    - `relationship`: the known features only. These are counts and dates, never content.
- Today responses add `interruptBudget: { limit, used, day }` (`limit` is null for no limit; `day` is `YYYY-MM-DD`), plus `queueTotal` and `rankedAt` (ISO). Clients re-apply ranks only on focus or refresh.
  - The Today responses are `GET /api/email?window=today` and `GET /api/inbox/firewall`. A ranked QUEUE lane page also carries `rankedAt`.
  - `used` counts the day's slot rows, hidden ones included. `queueTotal` is the QUEUE lane's count for the same inbox scope.
- Open, and not in v3.0:
  - MEETING outside the budget (security review, P3 PR2). MEETING needs no sender trust: an `.ics` part from anyone makes a certain event. It shares the per-user push rate limit (3 per 10 minutes) with PUSH. A flood of invites can therefore use up the rate limit, so that a budgeted PUSH claims its slot but its phone ring is rate-limited. v2 pushed MEETING the same way. Options are a small daily MEETING cap for untrusted senders, or requiring trust for an `.ics`-only MEETING push. This is a founder decision.
  - Floods that never claim a slot (security review). A PUSH that will not ring (quiet hours, preferences) stays in the PUSH lane and spends nothing. Many urgent-looking stranger mails in quiet hours, or held overflow outside them, all list ahead of ordinary QUEUE. Ranking orders held items by importance, so a trusted sender's held alert stays above a stranger's. P3 PR2b decides how to collapse or cap stranger held items in the Today list.
  - In ranking, "held" means `heldAt` is set, the lane is still QUEUE, and no human or agent lane is on the item. A manual override or an agent `set_tier` leaves `heldAt` in place, so readers must check all three.
  - Widening risk-only PUSH trust beyond VIP. Now that `SentMessage.origin` exists (#1591), "the user wrote to them" can become a signal: user-origin sends only, once legacy null rows have aged out or been classified. This would be a new `policyVersion`, decided on replay data.
  - Calendar conflict title and time. `event.conflict` stays null until P2 reads the calendar.
  - "Always interrupt for payment/security past the budget". This is a design proposal and a founder decision, OFF until decided. The params `{risk, overBudget: true}` are reserved for it.
  - The Important / Not important feedback endpoint. It belongs to P0 outcome stamping.
- Clients that re-sort lists themselves must adopt the server order behind the same flag: mobile Today and Cover sort by priority, Mac Inbox mode sorts by time, and mobile groups by day.

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
