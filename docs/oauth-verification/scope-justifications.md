# Scope Justifications — paste-ready for the Google verification form

**App narrative (for the "how does your app use Google user data" box):**

> Klorn (app.klorn.ai) is an AI email attention firewall. It connects to a
> user's Gmail account and classifies every incoming message into one of four
> attention tiers — PUSH (notify now), QUEUE (batched review), SILENT
> (archived context), or AUTO (handled automatically) — so the user is only
> interrupted by mail that genuinely needs them. Klorn reads message content
> to classify and summarize it, applies labels/read-state to reflect the
> user's triage decisions, and sends replies only through an explicit
> user-approval flow. Calendar access is used to give the triage engine
> meeting context (conflicts, free/busy, deadlines) and to create events the
> user approves. All Google user data is used solely to provide these
> user-facing features, per the Limited Use policy.

---

## `https://www.googleapis.com/auth/gmail.readonly` (restricted)

Klorn's core feature is reading each incoming message's headers and body to
classify it into one of four attention tiers (PUSH / QUEUE / SILENT / AUTO)
and to generate the short per-message summaries and daily briefing shown in
the app. Classification quality depends on message content — sender, subject,
and body — so metadata-only access is insufficient, and Klorn performs
continuous background sync of new mail, which the narrower per-message
consumption patterns of `gmail.metadata` do not support for body-based
classification. Without this scope the product has no input: nothing can be
classified, summarized, or surfaced, and the app is non-functional.

## `https://www.googleapis.com/auth/gmail.send` (restricted)

Klorn lets users reply to triaged mail from inside the app, including
AI-drafted replies that the user reviews and approves before anything is
sent. Every send is executed through a deterministic approval gate: the exact
approved payload is hashed into a signed action receipt at approval time and
re-verified at send time, so Klorn can only ever send the bytes the user
approved. This is the minimum scope that permits sending on the user's
behalf; without it the reply and approved-auto-reply features break and users
must leave the app to act on the very messages Klorn surfaced.

## `https://www.googleapis.com/auth/gmail.modify` (restricted)

When Klorn triages a message (or the user acts on one), the outcome must be
reflected back into Gmail: applying/removing labels for the attention tiers,
marking messages read/unread, archiving SILENT-tier mail, and moving messages
to trash when the user approves a delete (Klorn uses reversible trash, never
permanent deletion). `gmail.modify` is the least-privileged scope that allows
label and mailbox-state changes — the alternative, full `mail.google.com`
access, is far broader and unnecessary. Without this scope Klorn's triage
decisions would exist only inside Klorn, leaving the user's actual inbox
untouched and defeating the product's purpose.

## `https://www.googleapis.com/auth/calendar.events` (sensitive)

Klorn turns actionable emails into calendar events: when a message contains a
meeting request or deadline, the user can approve creating or updating an
event without leaving the triage flow, and Klorn reads upcoming events to
attach meeting context to related messages and briefings. Read-only calendar
access cannot create the user-approved events, and full `auth/calendar` is
broader than needed — `calendar.events` is the minimal scope covering
event read/write on the user's calendars. Without it, email-to-event capture
and event-aware triage break.

## `https://www.googleapis.com/auth/calendar.readonly` (sensitive)

Klorn checks availability across *all* of the user's calendars — including
secondary and subscribed calendars — to detect scheduling conflicts and
compute free/busy when triaging meeting-related email and preparing the daily
briefing. This requires `calendarList.list` plus free/busy over every
calendar, which `calendar.events` (per-calendar events only) does not cover.
It is also the only calendar scope requested when a user links a secondary
Google account for availability, keeping that linked account read-only with
no mail access. Without it, conflict detection silently misses meetings on
non-primary calendars.

## `openid`, `userinfo.email`, `userinfo.profile` (non-sensitive)

Requested at sign-in to authenticate the user, create their Klorn account,
and display which Google account is connected. `userinfo.email` is also
requested when linking a secondary account so Klorn can show the user which
account each linked calendar or inbox belongs to. These identity scopes are
the standard minimum for Google sign-in and account labeling.

<!--
CODE EVIDENCE (strip before submission)
- Exact scope arrays: packages/api/src/mail/gmail.ts:66-78 (login), :46-55 (reconnect),
  :95-99 (secondary calendar link — calendar.readonly only, least-privilege comment at :83-88),
  :118-124 (secondary inbox link — gmail scopes only, no calendar, comment :103-111).
- gmail.readonly usage: continuous sync + classification pipeline (packages/api/src/mail/gmail.ts,
  packages/api/src/mail/email-summarize.ts, packages/api/src/automation-scheduler.ts classify cycles).
- gmail.send usage + approval gate: packages/api/src/agentcore/auto-reply-send.ts:16-40
  (ActionReceipt binds exact bytes via payloadHash; routed through executeToolCall),
  packages/api/src/judge/attention-floor.ts:77-83,109 (ActionReceipt interface, sha256 payload hash).
- gmail.modify usage: label/read-state/archive updates in packages/api/src/mail/gmail.ts;
  delete = trash (reversible) at gmail.ts:1266, untrash at :1351.
- calendar.events usage: packages/api/src/routes/calendar.ts (create/parse/delete with Google sync),
  packages/api/src/google-calendar-time.ts, packages/api/src/event-parse.ts.
- calendar.readonly rationale: gmail.ts:51-53 comment (calendarList.list + freebusy for
  multi-calendar conflict detection); packages/api/src/pim/calendar.ts:159,202,285 (freebusy degrade
  paths when token predates the scope).
- Four-tier doctrine (PUSH/QUEUE/SILENT/AUTO): CLAUDE.md "What this is".
-->
