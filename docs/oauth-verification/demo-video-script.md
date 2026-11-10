# Demo Video Script — Google OAuth Restricted-Scope Review

**Target length:** 4–5 minutes. **Upload:** unlisted YouTube link.
**Language:** English narration (spoken or captions —
`demo-video-captions.srt` next to this file is upload-ready if you record
silently; timestamps match the scene timings below).

## Google's hard requirements (check every one before uploading)

- [ ] Use the **production** OAuth client — the client ID must be visible in
      the consent-screen URL (zoom the address bar; reviewers check the
      `client_id=` parameter matches the submission).
- [ ] Show the full OAuth consent screen listing the requested scopes, and
      the app name "Klorn" on it.
- [ ] Demonstrate **each restricted/sensitive scope** actually being used by a
      visible feature.
- [ ] Real UI at `app.klorn.ai` — no mockups, no localhost.
- [ ] Use a test Google account (e.g. a seeded demo inbox), never a real
      user's private mail.

---

## Scene 1 — App identity and entry (0:00–0:25)

**Screen:** Browser at `klorn.ai` landing page, then click through to
`app.klorn.ai` login page. Briefly show the footer links to Privacy Policy
and Terms.

**Narration:** "This is Klorn, an AI email attention firewall at
app.klorn.ai. Klorn connects to a user's Gmail and Google Calendar and
classifies every message into five attention lanes — PUSH, MEETING, QUEUE,
INFO, and SILENT — so users are only interrupted by mail that needs them. I'll sign in
with Google and show how each requested scope powers a user-facing feature."

## Scene 2 — Sign-in, then the Connect consent screen (0:25–1:00)

**Screen:** Click "Continue with Google". The first Google screen is the
account chooser with a minimal identity-only consent (email/profile) — show
it briefly and sign in. Klorn lands on onboarding's Connect step; click
**Connect Gmail & Calendar**. Pause on the full consent screen. **Zoom into
the address bar** so the production `client_id` is legible. Scroll the
consent screen slowly so every scope row is readable: the "Read, compose,
and send" items for Gmail and the Calendar items. Click Allow.

**Narration:** "Signing in with Google asks only for basic profile
information — Klorn follows incremental authorization, so no mail access is
requested at login. The Gmail and Calendar permissions are requested
separately, at the moment the user chooses to connect their inbox. Here is
that consent screen for our production OAuth client: Gmail read, send, and
modify access, plus Calendar events and read-only Calendar access. The user
sees exactly what is requested and consents before any data is accessed."

## Scene 3 — `gmail.readonly`: sync, classification, summaries (1:00–1:50)

**Screen:** Post-login dashboard. Show the inbox syncing, then the triage
view: messages sorted into PUSH / MEETING / QUEUE / INFO / SILENT lanes. Open one
message to show its AI summary and the daily briefing view.

**Narration:** "Immediately after connecting, Klorn uses the Gmail read-only
scope to sync recent messages and classify each one into an attention tier.
Message bodies are read to produce these per-message summaries and the daily
briefing. This classification is the core of the product — without read
access there is nothing to triage. Mail content is used only for this
classification and summarization; it is never used for advertising and never
read by humans."

## Scene 4 — `gmail.modify`: triage written back to Gmail (1:50–2:25)

**Screen:** In Klorn, archive a SILENT-tier message and mark a message as
read. Switch to a Gmail tab side-by-side and show the same message now
archived/read with Klorn's label applied. Optionally show a user-approved
delete moving a message to Gmail's Trash (and point out it's the reversible
Trash, not a permanent delete).

**Narration:** "When the user acts on a triaged message, Klorn uses the
gmail.modify scope to reflect that decision in the real mailbox — applying
tier labels, marking read, archiving, or moving a message to Trash after
explicit approval. Deletes always go to Gmail's reversible Trash. Here in
Gmail you can see the same message with Klorn's changes applied."

## Scene 5 — `gmail.send`: approved reply (2:25–3:05)

**Screen:** Open a QUEUE message that needs a reply. Show the AI-drafted
reply, edit a word to prove it's editable, then click the explicit
**Approve & Send** control. Show the confirmation/receipt state in Klorn,
then switch to Gmail's Sent folder showing the sent message.

**Narration:** "Replying uses the gmail.send scope, gated behind explicit
user approval. The user reviews and can edit the draft; on approval, Klorn
records a receipt of the exact approved content and sends precisely those
bytes — the system refuses to send anything that doesn't match what was
approved. Here is the message in the Gmail Sent folder."

## Scene 6 — `calendar.events` + `calendar.readonly` (3:05–3:50)

**Screen:** Open an email containing a meeting proposal. Show Klorn surfacing
the detected event and a conflict warning sourced from another calendar
(free/busy across all calendars). Approve creating the event; switch to
Google Calendar showing the created event.

**Narration:** "Calendar access powers meeting context. With the read-only
Calendar scope, Klorn checks free/busy across all of the user's calendars —
including secondary ones — to flag conflicts like this. With the Calendar
events scope, the user can approve turning an email into a calendar event
without leaving the triage flow. Here is the event in Google Calendar."

## Scene 7 — Same account, desktop app (3:50–4:15)

**Screen:** Launch the Klorn macOS app. Click its sign-in control — it opens
the **system browser** (not an embedded webview) on the same Google flow;
since the demo account already granted consent, Google returns immediately
and the app signs in. Show the menu-bar triage surface with the same
five lanes as the web app (retired AUTO appears only if the demo account still
holds pre-2026-08-18 rows; a fresh demo account will not).

**Narration:** "Klorn also ships a desktop client. It authenticates through
the system browser with the same OAuth client and the same identity-only
sign-in — no embedded webviews and no additional permissions. The desktop
app is another view of the same account; all Google data access still
happens on our backend, shown earlier."

## Scene 8 — User control: disconnect and delete (4:15–4:45)

**Screen:** Open Klorn settings. Show the disconnect-Google control and the
account-deletion control (hover, don't need to execute deletion on the demo
account — or run it on a throwaway). Optionally show
myaccount.google.com/permissions listing Klorn.

**Narration:** "Users stay in control: they can disconnect Google or delete
their Klorn account at any time, which purges all Google-derived data from
our systems. Access can also be revoked from the user's Google Account
permissions page. All Google user data is stored encrypted and used only for
the features shown in this video, in accordance with the Limited Use policy.
Thank you."

---

## Recording notes

- Seed the demo inbox beforehand with: 1 urgent message (PUSH), a few
  newsletter/receipt messages (SILENT), 1 reply-needed thread (QUEUE), and
  1 meeting-proposal email that conflicts with an event on a secondary
  calendar.
- Keep Gmail and Google Calendar open in adjacent tabs for the side-by-side
  proof shots (Scenes 4–6).
- 1080p minimum; zoom on the address bar in Scene 2 is the most commonly
  missed requirement.

<!--
CODE EVIDENCE (strip before submission — maps scenes to implementation)
- Scene 2 consent scopes: packages/api/src/mail/gmail.ts getLoginAuthUrl (identity-only
  sign-in) + getAuthUrl (Gmail/Calendar connect grant via POST /api/auth/google/start).
- Scene 3 sync/classify/summarize: packages/api/src/mail/gmail.ts (sync),
  packages/api/src/mail/email-summarize.ts, packages/api/src/automation-scheduler.ts
  (classify cycles + briefing, e.g. :844-861); five lanes per CLAUDE.md,
  canonical in AttentionItem.tier (packages/api/prisma/schema.prisma).
- Scene 4 modify/trash: packages/api/src/mail/gmail.ts:1266 (users.messages.trash),
  :1351 (untrash) — reversible trash, no permanent delete API call in the codebase.
- Scene 5 approved send: packages/api/src/agentcore/auto-reply-send.ts:16-40 and
  packages/api/src/judge/attention-floor.ts:17,27,77-83,109 (ActionReceipt minted at approve,
  sha256 payloadHash verified at execute; mismatch is a permanent refusal per
  packages/api/src/agentcore/action-outbox.ts:105-113).
- Scene 6 calendar: packages/api/src/routes/calendar.ts (create/delete with Google sync,
  :214), packages/api/src/pim/calendar.ts:159-285 (multi-calendar freebusy),
  packages/api/src/event-parse.ts.
- Scene 7 deletion: packages/api/src/user-deletion.ts:5-14, packages/api/src/purge-user-data.ts,
  packages/api/src/routes/auth.ts:1295 (user-facing deletion for restricted-scope review).
- Token encryption claim: packages/api/src/crypto-tokens.ts:5,23,135 (AES-256-GCM).
-->
