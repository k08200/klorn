# Rules DSL v1

Status: v1, behind `RULES_DSL_ENABLED` (off / cohort / on, default **off**).
Owner decision (LOCKED): Postgres stays the source of truth. No custom database,
no new language runtime. Klorn exposes the user's rules as **text** they can
read, edit, keep in git or Obsidian, dry-run and apply. The DSL is a text layer
over the rule machinery that already exists. It is **not** a new judging engine.

## 1. What already exists (the machinery the DSL sits on)

Read on 2026-11-14 (`main` at `63e11991`); line numbers are as of this change.

| Surface | Where | What the judge does with it |
|---|---|---|
| `EmailRule` | `packages/api/prisma/schema.prisma:1824` | One table, six `actionType`s (`EmailRuleAction`, `schema.prisma:1851`). |
| `PIN_TIER` rows | written by `mail/pin-rules.ts:44` (`replaceTierPins`), `routes/email.ts:1871` (`/:id/pin-tier`), `judge/screener.ts:141` (screener BLOCK), the generic `routes/email-rules.ts:169` | Read at cascade rank 0 by `judge/judge-context.ts:621` (`lookupPinnedTier`, matcher now in `mail/pin-match.ts:26`): exact address beats exact domain, equality only, public mailbox domains refused at read time. Consumed by `judge/poc-judge.ts:828` (v2) and `judge/v3/policy.ts:247` (v3, after a manual override). |
| `AUTO_REPLY` / `DRAFT_REPLY` rows | `mail/email-reply.ts:60` (`checkAutoReplyRules`), executed by `automation-scheduler.ts:1661` | **Sends mail** (`AUTO_REPLY`) or creates a draft. `subjectContains` is a substring match, `from` an address/domain match (`ruleSenderMatches`, `email-reply.ts:34`). |
| `LABEL` / `ARCHIVE` / `NOTIFY` rows | enum only | No reader anywhere in `packages/api/src` (grep for the literals finds only IMAP move roles). |
| `LearnedRule` | `schema.prisma:2199`, mined weekly (`automation-scheduler.ts:1228`) | `APPLIED` rows short-circuit the judge only under `LEARNED_RULES_IN_JUDGE` (`judge-context.ts:588`). Machine-derived. |
| `ScreenerDecision` | `schema.prisma:2366`, `judge/screener.ts:133` | A decision about a sender. BLOCK is implemented as a `PIN_TIER → SILENT` rule named `Screener block: <address>`; ALLOW deletes that rule and pins nothing. The judge never reads `ScreenerDecision` itself. |
| `FeedbackPolicyPreference` | `schema.prisma:2649` | Agent tool-approval preferences (`toolName`, `recipient`). Not a mail classification rule. |
| Interrupt budget | `AutomationConfig.interruptBudget` (`schema.prisma:1149`), `judge/v3/push-budget-gate.ts:149`, `JUDGE_V3_POLICY_VERSION` in `judge/v3/policy.ts:41` | A per-user number and a system policy version. Not a rule about mail. |
| Rules routes | `routes/email-rules.ts` (`GET/POST/PATCH/DELETE /api/email/rules`, `/rules/pins`, `/rules/compile`) | — |
| Web rules UI | `packages/web/src/components/rules-section.tsx` in Settings → Lanes (`app/settings/_sections/lanes-section.tsx`) | NL text → LLM-proposed pins → review → `POST /rules/pins`. |

Production shape (SELECT-only aggregate, 2026-11-14): `EmailRule`, `LearnedRule`,
`ScreenerDecision` and `FeedbackPolicyPreference` all hold **0 rows**. Nothing
below is shaped around legacy data; every guard is still written for rows that
any of the writers above can produce.

## 2. What v1 round-trips

The only user rule the judge executes for **classification** is the
`PIN_TIER` row: one sender (exact address) or one domain (exact, non-public)
always lands in one lane. That is exactly what v1 makes editable.

| Model / rows | DSL v1 | On apply |
|---|---|---|
| `EmailRule` `PIN_TIER`, well-formed (one address or one domain, a live lane, a name and note the DSL can spell) | **editable** `rule` block | replaced (diffed) |
| `EmailRule` `PIN_TIER` the DSL cannot spell (several senders, address + domain, public domain, retired or unknown lane, over-long name) | read-only comment | untouched |
| Screener BLOCK pins | editable like any pin (they are pins) | diffed like any pin; the name is kept, so the screener's ALLOW still finds it. Renaming one in the text detaches it: the screener's ALLOW deletes by the name `Screener block: <address>` and would no longer find it |
| `EmailRule` `AUTO_REPLY`, `DRAFT_REPLY` | read-only comment (name, sender count, active) — never the reply template | untouched (tested) |
| `EmailRule` `LABEL`, `ARCHIVE`, `NOTIFY` | read-only comment | untouched |
| `LearnedRule` | read-only comment (pattern, value, lane, status, evidence count) | untouched (tested) |
| `ScreenerDecision` | not exported (its BLOCK effect is the pin above) | untouched |
| `FeedbackPolicyPreference`, interrupt budget, policy version | not exported | untouched |

Why no subject matching, no glob, no label action in v1: no existing
classification rule reads them. A `when subject contains …` lane rule would
need a new read path in the judge, which makes the DSL a judging engine. A
label rule would be stored and never applied (`LABEL` has no executor). Both
are v2 candidates that need their own judge change and review.

## 3. Grammar (EBNF)

Line-oriented. One statement per line; indentation is not significant (the
serializer indents clauses by two spaces).

```ebnf
file        = { empty } , version , { empty | rule } ;
empty       = [ ws ] , [ comment ] , eol ;
version     = [ ws ] , "version" , ws , "1" , [ ws ] , [ comment ] , eol ;
rule        = header , { empty | clause } ;
header      = [ ws ] , "rule" , ws , string , [ ws ] , [ comment ] , eol ;
clause      = [ ws ] , ( when | then | note | "disabled" ) , [ ws ] , [ comment ] , eol ;
when        = "when" , ws , "from" , ws , ( "address" | "domain" ) , ws , string ;
then        = "then" , ws , "lane" , ws , lane ;
note        = "note" , ws , string ;
lane        = "PUSH" | "MEETING" | "QUEUE" | "INFO" | "SILENT" ;   (* case-insensitive *)
string      = '"' , { char | '\"' | '\\' } , '"' ;                 (* one line, no other escapes *)
comment     = "#" , { any char } ;                                  (* outside strings only *)
ws          = ( " " | "\t" ) , { " " | "\t" } ;           (* optional next to a string *)
```

Rules inside a `rule` block (checked after parsing, each with a line:column):

- exactly one `when` (a second one is `too-many-conditions`), exactly one `then`;
- at most one `note`, at most one `disabled`;
- keywords are lowercase; lanes are case-insensitive in ASCII only (`ſilent`
  is not SILENT) and serialized uppercase;
- one leading byte order mark is ignored;
- `from address` takes one email address, `from domain` one domain (a leading
  `@` is accepted and dropped). Both are lowercased.

## 4. Examples

```
version 1

# Investors always interrupt.
rule "Investors always interrupt"
  when from domain "sequoiacap.com"
  then lane PUSH

rule "Board calendar"
  note "kept even while the domain is muted"
  when from address "assistant@board.example"
  then lane MEETING

rule "Old newsletter"
  when from address "news@example.com"
  then lane SILENT
  disabled
```

Mute is `then lane SILENT`. There is no separate mute or pin verb: a `rule` is
a pin, and a pin is the only lane rule Klorn executes.

Rejected input and the error each gives:

```
  then lane AUTO                 col 13  retired-lane   "AUTO" is a retired value, not a lane. Use PUSH, MEETING, QUEUE, INFO or SILENT.
  then lane URGENT               col 13  unknown-lane   Unknown lane "URGENT". Use PUSH, MEETING, QUEUE, INFO or SILENT.
  when from domain "gmail.com"   col 20  public-domain  "gmail.com" is a public mailbox domain anyone can mail from. Write a rule for one address instead.
```

## 5. Mapping DSL ↔ `EmailRule`

| DSL | `EmailRule` column |
|---|---|
| `rule "<name>"` | `name` (1–120 characters) |
| `note "<text>"` | `description` (absent ⇄ `null`, ≤ 500 characters) |
| `when from address "<a>"` | `conditions = { "from": ["<a>"] }` |
| `when from domain "<d>"` | `conditions = { "fromDomain": ["<d>"] }` |
| `then lane <L>` | `actionValue = "<L>"` |
| — | `actionType = PIN_TIER` (always) |
| `disabled` present ⇄ absent | `isActive = false` ⇄ `true` |
| (not expressible) | `id`, `triggerCount`, `lastTriggeredAt`, `createdAt`, `updatedAt` are kept by the diff, never written from text |

Identity is the **sender**: `address:<a>` or `domain:<d>`. One rule per sender
in a file (a second is `duplicate-sender`), which is the
one-row-per-entity invariant every pin reader already assumes
(`pin-rules.ts:52`). A rule keeps its row id while its sender stays the same,
whatever else changes.

## 6. What is NOT expressible in v1

- Subject, body, category, recipient, attachment or time conditions.
- Several senders in one rule, `and` / `or`, negation, glob, substring, regex.
- Any action other than a lane: no reply, draft, send, forward, archive,
  delete, label, notify or calendar change. **No new execution power.**
  Reply rules are visible as read-only comments and are managed where they are
  today; approval-based execution stays LOCKED.
- Rule order or priority. Precedence is fixed by the judge: a manual move of a
  mail beats a pin; an address rule beats a domain rule; nothing else competes,
  because one sender has at most one rule.
- Comments and blank lines are not stored. Postgres holds the rules; the text
  is regenerated from them (§9).

## 7. Errors

Parse and compile return every error up to a cap of 50 (then `truncated: true`):

```json
{ "line": 4, "column": 13, "code": "unknown-lane", "message": "Unknown lane \"URGENT\". Use PUSH, MEETING, QUEUE, INFO or SILENT." }
```

Lines and columns are 1-based; a column counts UTF-16 code units, which is
what a browser `<textarea>` selection uses. Any user text quoted back in a
message is cut to 40 characters (`…` appended) and has control characters
replaced, so an error can never echo an unbounded or multi-line input.

Codes: `missing-version`, `unsupported-version`, `unexpected-token`,
`unterminated-string`, `bad-escape`, `forbidden-character`,
`statement-outside-rule`, `empty-rule-name`, `duplicate-clause`,
`too-many-conditions`, `missing-when`, `missing-then`, `unknown-lane`,
`retired-lane`, `invalid-address`, `invalid-domain`, `public-domain`,
`duplicate-sender`, `text-too-large`, `too-many-rules`, `string-too-long`.

## 8. Security limits

| Limit | Value | Code |
|---|---|---|
| Text size (UTF-8 bytes) | 64 KiB | `text-too-large` (checked before parsing) |
| Rules per file | 500 | `too-many-rules` |
| Conditions per rule | 1 | `too-many-conditions` |
| Rule name | 120 characters | `string-too-long` |
| Note | 500 characters | `string-too-long` |
| Address / domain | 254 characters (RFC 5321 path limit), counted as written and again lowercased | `string-too-long` |
| Errors returned | 50; parsing and compiling stop once the cap is passed | `truncated: true` |
| Read-only lines in an export | 100, then `# ... N more read-only entries not shown.` | — |
| Dry-run sample | 500 most recent judged mails max (default 200), 20 listed | — |

- **No user-supplied pattern is ever executed.** Matching is equality on a
  lowercased address or domain, the same pure function the judge uses
  (`mail/pin-match.ts`, extracted from `lookupPinnedTier`, so a dry-run cannot
  drift from the judge). The parser is a single left-to-right scan with no
  regular expression over the text. Address/domain validation reuses the pin
  writers' fixed validators (`mail/pin-validate.ts`). Their two patterns
  backtrack quadratically on a crafted failing input, so `validateTierPin` now
  refuses a value over 254 characters (as written, and again lowercased)
  before either runs. That also closes the same exposure on the existing
  `POST /api/email/rules/pins`, which had no length cap.
- No existing `EmailRule` field the DSL edits stores a regex. `subjectContains`
  (reply rules only) is a substring match in `email-reply.ts`; the DSL does not
  edit it.
- Rejected anywhere in the text (`forbidden-character`), so a file in git
  shows what it does: C0 controls except tab, DEL and C1 controls
  (U+0080–U+009F), the line and paragraph separators (U+2028, U+2029),
  zero-width and invisible format characters (U+200B–U+200F, U+2060–U+2064,
  U+180E, U+FEFF after the first character), bidirectional marks, overrides
  and isolates (U+061C, U+202A–U+202E, U+2066–U+2069), and lone surrogates. A
  zero-width character inside a sender would otherwise make a pin that looks
  right and never matches.
- Read-only comments are generated from stored names; those are cut to 60
  characters and stripped of control characters, so a stored name cannot end a
  comment line and smuggle a statement into the exported file.
- Every route is behind the default-deny session guard (`security/route-auth-guard.ts`)
  plus an explicit `requireAuth`, then the cohort gate, and every query and
  write is scoped by the session's `userId`. Writes additionally match
  `actionType = PIN_TIER`, so a stale or forged plan cannot touch a reply rule.
- Rate limits: export 30/min, validate 60/min, dry-run 20/min, apply 10/min
  (the app's limiter keys them by client).

## 9. Round-trip guarantee

`serialize(rows)` is canonical: header, `version 1`, editable rules sorted
(address rules, then domain rules, each by sender), then the read-only
comments. No timestamps, so an unchanged rule set exports byte-identical text
(git-diff friendly).

Guarantees, each covered by golden and property tests:

1. `serialize(compile(parse(serialize(x)))) === serialize(x)` for every rule
   set `x` the serializer accepts.
2. Every row classified editable serializes to text that parses and compiles
   back to the same name, note, sender, lane and active state. A row that
   would not is classified read-only instead.
3. Applying an unchanged export writes nothing, except merging duplicate
   rows for one sender (several rows for one sender are a leftover of a
   double-submit; the one the judge reads is exported and the rest are
   removed on apply, as `replaceTierPins` already does).
4. Apply never creates, changes or deletes an `AUTO_REPLY`, `DRAFT_REPLY`,
   `LABEL`, `ARCHIVE` or `NOTIFY` row, a read-only `PIN_TIER` row or any
   `LearnedRule`.

Not preserved: comments, blank lines, rule order, keyword case of lanes,
`@` before a domain.

An account over the text limits (more than 500 editable pins, or an export
over 64 KiB) still gets its export, flagged `applicable: false`: the editor
says so and disables Apply rather than failing on it.

## 10. Versioning

The first statement must be `version 1`. Any other number is
`unsupported-version`. A future v2 (for example subject conditions, once the
judge reads them) bumps the number; a v1 file stays valid v2 input, and the
server keeps exporting the lowest version that can express the rule set.

## 11. API (all under the flag; 404 while off, before auth)

| Method + path | Body | Answer |
|---|---|---|
| `GET /api/email/rules/dsl/export` | — | `{ text, baseHash, ruleCount, readOnlyCount, applicable }` |
| `POST /api/email/rules/dsl/validate` | `{ text }` | `{ ok, ruleCount, errors, truncated }` |
| `POST /api/email/rules/dsl/dry-run` | `{ text, limit? }` | 400 with errors, or `{ examined, changed, manualKept, transitions[], samples[] }` |
| `POST /api/email/rules/dsl/apply` | `{ text, baseHash }` | 400 with errors, 409 `rules-changed` when `baseHash` is stale, or `{ added, changed, removed, unchanged, text, baseHash, applicable }` |

Dry-run is read-only: two `findMany`s (the newest judged mails, skipping
items with no lane yet, and their senders) plus the user's rules, no write.
The proposed pins are ordered as the judge would read them after apply: a
rule apply leaves untouched keeps its row's `updatedAt`, a created or changed
one counts as newest, and kept read-only pins stay in at their own
`updatedAt`. For each mail it applies the pin
cascade with the current and the proposed rules: a mail the user moved by
hand keeps its lane (`manualKept`); otherwise "before" is the lane the
current pins give (or the mail's own lane when no pin decided it) and a
change is a proposed pin with a different lane. A mail whose current pin the
text removes is listed with `to: null` ("back to the judge"), because
predicting the judge's lane would mean running it. The interrupt budget is
not modelled.

Apply re-reads the rules and refuses with 409 if `baseHash` no longer
matches. `baseHash` is a SHA-256 over the editable pins the export was made
from (row ids included), not over the text: a pin made from the mail view
while the editor was open makes it stale, so that pin is never silently
deleted; a reply-rule edit or a weekly learned-rule run does not.

Everything runs in one interactive transaction (`INTERACTIVE_TX_OPTIONS`):
take `pg_advisory_xact_lock(<rules-dsl class>, hashtext(userId))` so one
user's applies run one at a time, re-read the pins, compare `baseHash`, then
delete removed pins, update changed ones, create new ones and write one
`RuleChangeAudit` row (counts and a SHA-256 of the text, no rule content).
Every delete and update must touch exactly the rows the plan names; if
another pin writer (which does not take the lock) changed one in between, the
whole transaction rolls back and the answer is 409. Pins apply to new mail; mail already judged keeps its lane, as with
every other pin writer.

## 12. Rollout

`RULES_DSL_ENABLED=cohort` with the founder in `ROLLOUT_COHORT_USER_IDS`
first; `/api/auth/me` reports `user.rulesDsl`, and the web shows the panel in
Settings → Lanes only when it is true. Flipping to `true` is a separate
founder decision.
