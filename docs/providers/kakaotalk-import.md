# KakaoTalk chat-export import (v1)

Status: built dark behind `KAKAO_IMPORT_ENABLED` (`off|cohort|on`, default off).
Code: `packages/api/src/kakao-import/`, `packages/api/src/routes/kakao-import.ts`,
`packages/web/src/app/settings/_sections/kakao-import-panel.tsx`.

## 1. What v1 does

The user exports one KakaoTalk chat in KakaoTalk itself and uploads the file in
Settings → Integrations → KakaoTalk import. Klorn parses it, the user picks which
speaker name is theirs, and Klorn suggests commitments ("내일까지 보내드릴게요")
from the chat's recent messages through the existing Commitment Ledger. The
suggestions land in Commitments → To confirm. They are never confirmed on their own.

It is a one-shot import, not a sync. There are no Kakao credentials, no scraping
and no unofficial clients. KakaoTalk has no chat-read API: Kakao confirmed this
officially on 2025-10-24, and only the outbound "send to me" channel exists. The
user's own export is the only legitimate input.

## 2. Formats

The parser is `kakao-import/parse.ts` with the scanners in `scan.ts`. It is pure:
no I/O, no clock and no zone. It recognises the format from the first message line
within the first 1,000 lines, then reads the whole file in that one format.

| Format id | Line shape | Typical source |
|---|---|---|
| `mobile-dotted` | `2026. 11. 10. 오후 3:21, 이름 : 메시지` (also `15:21`, `3:21 PM`) | mobile export, dotted date |
| `mobile-korean-date` | `2026년 11월 10일 오후 3:21, 이름 : 메시지` | mobile export, Korean date |
| `mobile-english-date` | `November 10, 2026 at 3:21 PM, Name : text` / `Nov 10, 2026, 3:21 PM, Name : text` | mobile export, English UI |
| `pc-bracketed` | `[이름] [오후 3:21] 메시지`, date from `--------------- 2026년 11월 10일 화요일 ---------------` (or `Tuesday, November 10, 2026`) | PC/Mac `.txt` |
| `csv` | header `Date,User,Message`, rows `2026-11-10 15:21:33,"이름","메시지"` (RFC 4180 quoting, multi-line fields) | PC `.csv` |

How it reads each part of a file:
- **Times.** 오전/오후, AM/PM and the 24-hour clock all work. A meridiem on both
  sides of the time, an impossible hour or an impossible date is not a header. The
  line is then read as a continuation of the previous message.
- **Multi-line messages.** A line with no header continues the previous message.
- **Date lines.** Mobile date lines, with or without a time, start no message and
  never join one.
- **Notices.** These are dropped and counted as `systemLines`:
  - In mobile formats, a timestamped line with no ` : ` (joins, leaves, invites).
  - In PC `.txt`, a short line ending in a known notice suffix (`님이 들어왔습니다.`,
    `left this chatroom.`, …).
- **Media and deleted placeholders.** `사진`, `사진 3장`, `동영상`, `이모티콘`,
  `파일: …`, `Photo`, `삭제된 메시지입니다.` and similar are kept as `media` or
  `deleted` for the counts. They are never processed.
- **Speaker boundary.** The first ` : ` within 83 characters of the time ends the
  speaker name. Control, zero-width and bidi characters are dropped from names, so
  a name cannot hide characters or spoof its display.
- **PC date separators.** Only the dashed separator sets the day. A message's own
  line that happens to be a bare date stays part of that message.
- **File placeholders.** `파일: …` / `File: …` counts as media only when a file name
  with an extension follows. `파일: 내일 보낼게요` stays text.
- **Encoding.** UTF-8 only. A BOM is dropped and CRLF is read like LF. These are
  refused with a code:
  - UTF-16, with or without a BOM (NUL bytes)
  - CP949/EUC-KR or any other invalid UTF-8
  - a `.zip`, which gets its own code: the UI says to unzip it and upload the `.txt` inside
- **Unknown formats.** A file with no recognisable message line is refused, never
  guessed at:
  - with a KakaoTalk title or save-date header line: `no-messages`
  - otherwise: `unknown-format`

**The fixtures were written by hand.** They are synthetic, under
`packages/api/src/__tests__/fixtures/kakao/`, and come from the documented shapes
above, not from real exports. No real KakaoTalk export has been run through the
parser yet. Locale and app-version variants not listed here will be refused as
`unknown-format`, and v1 widens the scanners only from real failures.

## 3. Limits

| Limit | Value | On breach |
|---|---|---|
| File size | 10 MiB (bytes, before decoding) | 413 `file-too-large` (pre-checked from `Content-Length`, then on the bytes) |
| Lines | 400,000 | 413 `too-many-lines` |
| Line length | 8,000 UTF-16 units | the line is truncated, parsing continues |
| Message length | 4,000 UTF-16 units | the message is truncated (continuation lines stop counting) |
| Messages | 200,000 | 413 `too-many-messages` |
| Distinct speakers | 500 | 422 `too-many-speakers` |
| Speaker name | 80 characters | the name is truncated |
| Processed window | last 30 days before the upload, +1 day for a clock running ahead | older messages are counted, never stored |
| Messages stored per import | the latest 2,000 text messages in the window | the oldest are dropped (`windowTruncated` in the preview) |
| Commitment candidates per import | 40 (each at most one LLM call), 2 per message | the import settles `DONE` with `errorCode: "partial"` |
| One processing pass | 10 minutes | settles `partial` |
| Imports kept per user | 20 | 409 `too-many-imports` |
| Imports waiting or being read per user | 2 | 409 `import-in-progress` |
| Uploads parsed at once per API instance | 2 (each holds up to ~100 MB while it runs) | 503 `busy`, refused before the body is read |
| Rate limits (per user and per client address) | preview 30/hour, import 10/24h, reads 120/min, delete 30/min | 429 `rate-limited` |

**DoS posture.** This repo has had event-loop outages from regexes and parsers on
untrusted text (#1414, #1466/#1467, #1534/#1535). The parser is a linear,
line-oriented state machine. Each line is read once by hand-written forward-only
scanners over a bounded prefix, and no regex touches export text.
`kakao-import-parse-linear.test.ts` checks it with CPU time, never wall time:
- doubling the input roughly doubles the work, for each hostile shape
  (near-miss headers, open brackets, dash runs, unclosed CSV quotes, one line
  with no newline);
- a max-size 10 MiB file parses within a CPU budget.

The parse takes about 130 ms of CPU locally for a 10 MiB file of real-shaped messages.

Windowing does not convert every message's time either (`window.ts`). One zone
conversion costs a few `Intl` calls, and 200,000 conversions would stall the event
loop for seconds. Instead:
- a message whose printed wall clock is more than 2 days outside the window is
  dropped before any conversion (no zone is a day off UTC);
- the rest share one conversion per wall-clock hour, exact per message only in an
  hour where the zone's offset changes (daylight saving);
- the preview's first and last times are two conversions.

`kakao-import-window.test.ts` holds 180,000 messages (all in the window, or spread
over five years) to a CPU budget.

**Why the window is measured from now.** An open promise is a recent one; older
ones are mostly done or stale. Measuring from the upload, not from the chat's last
message, means an old export yields nothing to process instead of a ledger of
long-past deadlines. It also stops a five-year chat from spending the user's LLM
budget.

## 4. Processing and commitments

`POST /api/kakao-import` stores the in-window text messages, one
`KakaoImportMessage` each. The `kakao-import` scheduler (`scheduler.ts`, every
30 s, under its own row lease) then processes one waiting import per tick
(`process.ts`):

1. It claims the oldest `PENDING` import of a user the flag reaches. In cohort mode
   that is only `ROLLOUT_COHORT_USER_IDS`. A `PROCESSING` claim older than 30
   minutes belonged to a dead pass and is taken over. A pass settles only the claim
   it holds (its `claimedAt`), so a pass whose claim was taken over changes nothing.
2. Messages are read newest first: when a limit stops the pass, the oldest go unread.
3. Each message goes through the existing ledger ingestion,
   `extractAndUpsertCommitmentsFromText`, with these fields:

   | Field | Value |
   |---|---|
   | `sourceType` | `KAKAO` (new enum value, own migration) |
   | `threadId` | `kakao-import:<importId>` |
   | `sourceId` | `kakao-import:<importId>:<seq>` |
   | dedup scope | the message (`sourceId`): the same words from two speakers or on two days are two promises; a re-run of the same message dedups |
   | `referenceDate` | the message's own time, so "내일" resolves against when it was written, in the user's zone |
   | `senderIsUser` | whether the user wrote it |
   | `contextTitle` | `KakaoTalk · <speaker>` for others, `KakaoTalk` for the user |

4. The rule extractor runs first. Only a rule candidate reaches the LLM refiner,
   and only when `COMMITMENT_LLM_REFINEMENT` is on.
5. Ownership:
   - Another speaker's first-person promise is theirs (`COUNTERPARTY`).
   - The user's own is `USER`.
   - The refiner is told the author with a `Message author:` line in its user
     prompt, KAKAO only. The shared system prompt and the mail and Slack prompts
     are unchanged.
6. Confidence is capped at 0.69, below the 0.7 confirmation line
   (`pim/commitment-ingestion.ts`, the same rule as Slack). A Kakao commitment is
   always suggested until the user confirms it.
7. A failed message is skipped and counted; five failures in a row stop the pass.
   The import settles `DONE` with its counts (`partial` if anything was skipped or a
   limit stopped it), or `FAILED` with `processing-failed` if it could not even load.
   The stored message text is deleted in the same transaction either way.
8. If the user deleted the import mid-run, the pass deletes whatever it made when it
   settles. It checks that the import still exists after every message that
   produced a candidate, and every 25 messages otherwise, and stops early.

**Budget.** The refiner charges the user's own daily cap:
- It calls `createCompletion` with the `userId` and `priority: "background"`.
- It never uses the judge's reserved slice, which is held for new mail.
- It runs on the user's BYOK keys when they have them (`getUserLlmCredentials`,
  newly passed through for this source). The per-user $1/day cap and the BYOK rules
  in `createCompletion` apply unchanged.
- Usage is labelled `kakao-import` in the LLM usage ledger.

The pass yields to the event loop every 20 messages, so a long import cannot hold
the API's loop. It stands down under `BACKGROUND_AGENTS_DISABLED`; the purge does not.

**Re-importing.** Dedup is per message of one import. Re-importing an overlapping
export of the same chat can suggest the same commitment twice; delete the older
import first. v1 keeps no chat identity: it would mean storing the chat title or
speaker list.

**Who is "me".** Speakers are told apart by display name only. A participant whose
name equals the user's, or two people with one name, cannot be separated: their
messages count as the user's. The preview's per-name counts are the check; the
result is still only suggestions.

## 5. Stored data and retention

| Data | Where | Kept | Why |
|---|---|---|---|
| Format, message/speaker counts, window bounds, outcome counts, error code, timestamps | `KakaoImport` | until the user deletes the import or the account | the result summary, and the handle for "delete this import" |
| In-window message text (capped at 4,000), speaker display name, time, `fromMe` | `KakaoImportMessage` | deleted when the import is processed; at most 7 days after upload (purge) | input to the processing pass |
| Suggested commitment: title, short evidence quote (≤500 chars), `KakaoTalk · <speaker>` description, counterparty name if the LLM names one, due date | `Commitment` (+ its `AttentionItem` mirror) | until the user deletes it, the import, or the account | the feature |

What is never stored:
- the uploaded file;
- its file name;
- the chat room title;
- messages outside the window;
- media and deleted-message placeholders;
- phone numbers or profile data (exports carry none);
- the preview's speaker list (the preview stores nothing at all).

No data is used to train any model.

How it is deleted:
- **Purge** (`purge.ts`). It runs every 10 minutes from the import scheduler,
  whatever `KAKAO_IMPORT_ENABLED` or `LOG_RETENTION_ENABLED` say. It deletes
  `KakaoImportMessage` rows older than 7 days and marks imports still waiting by
  then `FAILED` / `expired`.
- **Delete this import** (`DELETE /api/kakao-import/:id`). It deletes every `KAKAO`
  commitment with the import's `threadId` and their queue mirrors first, then the
  import and its messages (cascade). If the first step fails the row stays, so the
  user can retry. While the flag is off the route is dark: stored text still expires
  within 7 days, and account deletion still removes everything.
- **Account wipe and deletion.** `purge-user-data.ts` deletes both tables, and both
  cascade from `User`.
- **RLS.** Both tables have tenant isolation and system bypass policies, enforced
  by `rls-coverage-guard.test.ts`.
- **Data-wipe fence.** Both tables carry the BEFORE INSERT fence trigger
  (`FENCED_MODELS`), so a pass running during an account wipe cannot re-create
  them.

## 6. What is sent to the LLM

Only when `COMMITMENT_LLM_REFINEMENT` is on, and only for a message the rule
extractor flagged, the refiner prompt carries:
- the candidate sentence;
- the message text (compacted to 1,800 chars);
- the context title `KakaoTalk · <speaker display name>`;
- the due hint;
- the message time and the user's zone;
- `Message author: USER|COUNTERPARTY`.

Every piece of chat text is wrapped with `wrapUntrusted`
(`commitment:candidate`, `commitment:sourceText`, `commitment:contextTitle`,
`commitment:dueHint`), as for mail. The system prompt tells the model to reject
prompt-injection instructions. Even a fully "convinced" model cannot confirm a
commitment, because of the 0.69 cap.

No chat text is put into Sentry by this feature:
- processing errors are reported as a new error carrying only the original error's
  name (`kakao-import: <name>`);
- route errors are fixed strings with a code and never echo the file, a field or a
  speaker name.

The shared refiner's own failure report (`pim/commitment-refiner.ts`, unchanged,
used by mail too) passes the provider's error object with sizes in `extra`. No path
was found that puts chat text in such an error's message, but that is not proven.

## 7. API and web

All routes are under `/api/kakao-import`. They answer Fastify's default 404 while
the flag is off, even unauthenticated. Each one runs `requireAuth` then
`cohortGate`, and acts on the session user's own rows only.

| Route | Body | Answer |
|---|---|---|
| `POST /preview` | multipart: `file` | `{ preview: { format, totalMessages, windowMessages, windowTruncated, speakers: [{name,total,inWindow}], firstAt, lastAt, windowStart, windowEnd, windowDays } }`; stores nothing |
| `POST /` | multipart: `consent=true`, `me=<speaker name>`, `file` (the same file again) | 201 `{ import }`; `consent-required`, `speaker-not-found`, `too-many-imports`, `import-in-progress` |
| `GET /` | — | `{ imports: [...] }`, newest first |
| `GET /:id` | — | `{ import }` or 404 `not-found` |
| `DELETE /:id` | — | 204, or 404 `not-found` |

Parse refusals map to these statuses:
- 400: `empty-file`, `invalid-upload`
- 413: `file-too-large`, `too-many-lines`, `too-many-messages`
- 415: `unsupported-encoding`, `zip-not-supported`
- 422: `unknown-format`, `no-messages`, `too-many-speakers`
- 503: `busy` (both upload routes, when the instance's upload slots are taken)

The web learns the flag from `/api/auth/me` `user.kakaoImport`. The panel lives in
Settings → Integrations and renders nothing while the flag is off. It has six parts:
1. export instructions (phone; PC/Mac);
2. a file picker that checks the 10 MB cap client-side;
3. "Check file", which shows the preview;
4. the speaker pick;
5. a consent checkbox, required, saying the file holds other people's messages and
   what Klorn does with them;
6. Import, then a list of imports with status, outcome and Delete (polls while
   one is waiting).

All strings are in the 7 locales.

## 8. Not in v1

- `.zip` exports. Unzipping untrusted archives means zip-bomb handling; the user
  unzips instead.
- Non-UTF-8 exports. Older Windows builds may write CP949; these are refused.
- Decisions as their own kind beyond what the ledger's `DECISION` kind already
  extracts.
- Cross-message context for the refiner. Each message is extracted on its own.
- Any sync, background re-import, or Kakao account link.

## 9. Decisions taken on the founder's behalf (reversible, all dark)

- **Window: last 30 days from upload, latest 2,000 text messages.** Bounds cost; recent promises are the open ones.
- **Per-import LLM bound: 40 candidates, 2 per message, 10-minute pass.**
- **Retention: text deleted on processing, hard cap 7 days (same as Slack).** The import row (counts only) is kept until deleted.
- **Two-step upload re-sends the file instead of keeping a server-side draft.** The preview stores nothing.
- **20 kept imports per user, 2 waiting or being read at once, 2 uploads parsed at once per instance; rate limits as in §3.**
- **The speaker display name is stored with the text (≤7 days) and on the commitment description.** It tells the card who owes what.
- **BYOK passthrough added to the shared commitment refiner, used only by this source.** Mail and Slack refinement still use the shared env providers, as before.

## 10. Self-host

Set `KAKAO_IMPORT_ENABLED=on` (or `cohort` with `ROLLOUT_COHORT_USER_IDS`). It
needs nothing else.

Commitment suggestions use the rule extractor alone unless
`COMMITMENT_LLM_REFINEMENT` is on.
