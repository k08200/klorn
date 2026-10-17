# Founder roadmap, 2026-10-15 — every ask mapped to the code

Source: the founder's 2026-10-15 brief (desktop, blog, chatbot, Apple login,
languages, Inbox Zero design and features, MCP, Slack/Telegram/CRM, prompts,
clean email, attachments, pricing, team mode, multi-account, spam, sender
analysis, GEO), checked against `main` at `c32d714`, the Notion competitive
analysis (last edited 2026-09-14) and Inbox Zero's open-source landing code.

The product thesis is already written down and decided:
`providers/unified-platform-plan.md` (2026-09-28) — every mail, calendar and
file source a person already uses, behind one Klorn login; Klorn-owned mail,
calendar and drive fill gaps and are not the product. Company accounts that an
admin blocks are answered by the company edition (`design/team-mode-v3.md`).
This file does not reopen those decisions. It records where each ask stands
and the order to finish them.

Status: **shipped** = live on `main` and on by default · **built, OFF** = on
`main` behind a flag or a founder action · **partial** · **missing**.

## 1. Status of every ask

| Ask | Status | Where / what is left |
|---|---|---|
| Blog visible in the top bar | shipped | Root landings in 7 languages and every subpage already linked `/blog/`. The new landing (`/next/`, EN and KO) linked it only from the footer — fixed. The web app now links it from the account menu. |
| Chatbot bottom-right in the desktop app | shipped | `apps/desktop-mac/Sources/KlornMac/Assistant/AssistantDock.swift`, mounted in `Shell/FullView.swift` and `Shell/MainShell.swift`; the web equivalent is `components/assistant-dock.tsx`. Same thread as the Assistant tab, and it knows which mail is open. |
| Claude Code / Codex integration | built, write tools OFF | Klorn is an MCP server (`POST /api/mcp`, keys in Settings). `docs/mcp/connect-clients.md` covers Claude Code, Codex CLI, Cursor, Gemini CLI, xAI. Write tools (`mark_read`, `set_tier`, `create_draft`) wait on `MCP_WRITE_TOOLS_ENABLED`. Not built: reading another app's local chat tabs (see §3). |
| Sign in with Apple | built, OFF | Code merged (`api/auth/apple.ts`). Founder action: Apple Developer console steps in `launch/social-login-activation.md`, then `APPLE_LOGIN_ENABLED`. |
| 6+ languages | shipped | Web, Mac app and site: EN, KO, JA, ZH, ES, FR, DE. Gap: the blog is English only. |
| Inbox Zero-style design and marketing | in progress | New landing at `/next/` (P11a, #1396). §4 lists what to take from Inbox Zero's page. |
| Auto labeling | partial | The five lanes are written back as Gmail labels behind `GMAIL_LABEL_MODE_ENABLED`. Topic labels like Inbox Zero's (Newsletter, Recruitment, Receipt) are a separate axis that needs a vocabulary decision — a label is never a lane (§3). |
| Auto unsubscribe | built, OFF | Per-mail one-click unsubscribe is live. The automatic path for SILENT promo mail is behind `AUTO_UNSUBSCRIBE_ENABLED` (Notion F4: only after per-user and per-host caps). Bulk view: **Subscriptions** (this branch), behind `BULK_UNSUBSCRIBE_ENABLED`. |
| Clean email (bulk cleanup) | partial | Bulk archive / mark-read for up to 100 messages (`routes/email-bulk.ts`). Subscriptions adds unsubscribe-and-archive per sender. A privacy-led "clean everything older than N from noise senders" sweep is not built. |
| MCP | built | See Claude Code row. Public registry listing (A8) waits on write tools and docs. |
| Telegram | built, OFF | `TELEGRAM_CHAT_ENABLED` — control the inbox from chat. |
| Slack | missing | Only a billing feature key. Notion lists "Slack app" as a pending founder decision. |
| CRM | missing | Notion lists HubSpot as the candidate. Inbox Zero does this through Composio. |
| User-written prompts / rules | shipped | Plain-English rules compile to lane pins (`mail/rule-compile.ts`, Settings → Rules), plus skills, playbooks and automations. |
| Attachments, résumés | partial | Attachment text is extracted (`EmailAttachment`). Klorn drive shipped (D3). File summaries and search (D4) and saving attachments to a drive (Inbox Zero's "smart filing") are the next steps (§3). |
| Pricing (Free / Plus / Team, BYOK free) | in flight | #1398 raises Pro to $30. The tier ladder and BYOK-free remain for the founder's single repricing (§5). |
| Team mode: see colleagues' calendars, pick a time | partial, OFF | `TEAM_MODE_ENABLED`: saved teams, team free/busy, common slots, meeting drafts with invitations. The org model (members who each connect their own calendars) is team mode v3. |
| Two or three mail accounts at once | built, partly OFF | Up to 10 linked inboxes. Gmail and Naver are live; Outlook, iCloud and generic IMAP are built behind flags (Outlook also needs the Azure registration). |
| Spam folder read and triaged | shipped | `SPAM_INTAKE_ENABLED` is on by default: the 10 newest `in:spam` messages per sync. IMAP sync reads INBOX only. |
| Sender and thread analysis ("why did they send this") | shipped | `mail/sender-dossier.ts` (`GET /api/email/:id/sender-dossier`), `mail/thread-brief.ts`, sender traits, relationship graph, assistant memory. |
| Calendar across providers | built, OFF | Google live; Outlook (Graph), iCloud and Naver (CalDAV), Mac device calendars (EventKit) built behind flags. Samsung has no server API; it is reachable only through the phone's device calendar (C5, blocked on FA-8). |
| Drive across providers | partial | Klorn drive shipped behind flags. Google Drive (`drive.file` + Picker, after verification) and OneDrive are outlines D5 and D6. iCloud Drive and Naver MYBOX have no third-party API; device import (D7) is the only path. |
| GEO / SEO | shipped, extended | Sitemap, robots, `llms.txt`, JSON-LD on landings and posts, `/vs/*` and `*-alternative` pages. Added: JSON-LD on the blog index and pricing; `llms.txt` now links every comparison page and post. |

## 2. Order

1. **Founder actions that switch on what is already built** — no code. Apple
   console and `APPLE_LOGIN_ENABLED`; Azure registration for Outlook; the
   Notion F4 flag order (SCREENER → DAILY_DIGEST → TELEGRAM_CHAT →
   GMAIL_LABEL_MODE → AUTO_UNSUBSCRIBE after caps); then `MULTI_INBOX_SYNC`,
   the calendar providers and `BULK_UNSUBSCRIBE`. Most of the "one place for
   everything" promise is already code behind these switches.
2. **Inbox Zero parity for the cleanup half**: Subscriptions (this branch),
   then a privacy-led cleanup sweep. These are the features people sign up for.
3. **New landing to the root** (`/next/` → `/`), in all 7 languages, with the
   §4 sections and real screenshots of the unified view.
4. **Merge #1398** ($30) with the §5 follow-ups; the tier ladder at the single repricing.
5. **Drive D4** (file summaries and search), then smart filing of attachments.
6. **Slack** (the founder's pending decision), then CRM through one connector
   layer rather than one integration at a time.
7. **Company edition** (team mode v3), PR-0 being the admin-consent guide.

## 3. Positions on the open questions

- **Claude Code / Codex.** Do not scrape another app's local chat tabs:
  fragile, and it reads data the user never gave Klorn. The supported shape is
  the reverse: those tools already connect to Klorn over MCP, and Klorn keeps
  the history. What is missing is a `search_assistant_history` read tool and an
  export of assistant threads, so a Claude Code session can ask "what did I
  decide about X in Klorn" — small, and inside the A-workstream gates.
- **Topic labels.** Inbox Zero's Before/After graphic sorts mail into To
  Reply, Newsletter and Recruitment. Klorn already covers "To Reply" with reply
  state; topics are a second, optional axis (a tag on the row, filterable),
  never a sixth lane, and named in `product-vocabulary.md` before any copy.
- **Résumés and attachments.** Treat them as files, not mail: a résumé that
  arrives is indexed into the drive (D4) with its text, the sender dossier
  links to it, and the assistant can answer "the three candidates who applied
  this week". That needs D4 and nothing new in the classifier.
- **Company accounts an admin blocks.** The company edition is the answer and
  is already the plan. Each member connects their own calendar; nobody's
  calendar is read through someone else's token (team-mode-v3 consent rules).

## 4. What to take from Inbox Zero's landing (read from its source)

Section order: hero ("Meet your AI email assistant that actually works", a
"works with" row) → organized inbox (Before/After) → pre-written drafts with
calendar slots → manage from anywhere (Slack, Telegram, mobile) → started in
three steps → bulk unsubscribe → everything else → trust (open source, SOC 2,
GitHub stars) → pricing → testimonials → FAQ. Light canvas, 20px-radius white
cards with very soft shadows, colored label pills, product shots as stacked
tilted cards. Klorn's version leads with what Inbox Zero cannot claim: one
login across Google, Microsoft, Apple, Naver and company IMAP, with calendars
and files beside the mail. Never "only" or "unique" (Notion page 20).

## 5. Pricing

Decided by the founder in #1398 (open): web Pro moves from $8.99 to **$30**
(native $34.99), with a drift guard on the number. This file does not reopen
it. What #1398 still needs, from the 2026-10-15 site audit: drop the
"Founding price" chip on the landings (it makes no sense at the market
price), sync the og/twitter descriptions, rewrite the "$30 vs $30" contrast
in the /vs/ link copy, and add the pricing page's Offer JSON-LD (removed from
this branch so it never disagrees with the visible table). The Free / Plus /
Team ladder and "BYOK = free" stay open for the single repricing.

## 6. Full audit, 2026-10-15 — what this branch fixed, what is still open

Three read-only audits (web app, Mac app, website) ran against `main` the
same day. Only items that are not someone else's open PR are fixed here.

**Fixed on `claude/kind-fermi-6tblb6`**
- Site: Blog in the `/next/` top bar (EN, KO); Blog JSON-LD on the blog
  index; `llms.txt` links every comparison page and post; stale facts across
  the seven landings (Google verification done 2026-10-03, iCloud connectable,
  the CI eval gate instead of a retired accuracy figure, Approvals, no Outlook
  claim on /vs/fyxer) — see that commit for the exact list.
- Web: Subscriptions (bulk unsubscribe, `BULK_UNSUBSCRIBE_ENABLED`); Blog in
  the account menu; "decision queue" out of the 404 page and metadata; the
  legacy tab bar's empty slot; legacy chrome, palette and toasts translated;
  touch targets; dead components removed.
- Mac: lane / Approvals / Mail in the copy; the assistant starters and chat
  VoiceOver labels localized (they were Korean and English literals).

**Still open**
- Production users see the legacy web shell: `UNIFIED_HOME`, `MAIL_V2`,
  `ONBOARDING_V2` are OFF. Flipping them is the biggest visible upgrade.
- Mac: assistant history is memory-only (`AppModel.chatMessages`); the
  server keeps the conversation but the app never reloads it. Default surface
  (flag `macMainWindow` OFF) is the old full view.
- Mac has no Files, Subscriptions, rules, MCP keys or billing in Settings.
- Web has no user-facing mail analytics (who mails you most, what clogs the
  inbox) — Inbox Zero's "Email Analytics".
- Topic labels, Slack, CRM, Google Drive / OneDrive connectors (§1).
- `feat/landing-one-place` lists Apple Mail as "merged, not switched on",
  which contradicts #1406/#1408; fix before it merges.
- #1398 follow-ups listed in §5.
- The blog is English only; the Korean market has no Korean posts.
