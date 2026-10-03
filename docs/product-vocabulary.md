# Product vocabulary

The words Klorn's UI is allowed to use, and what each one means. Written down
because "inbox" was being read three different ways — a page, an account, and
the tier board — and nothing in the repo said which was correct.

Founder decision (2026-08-04): **"inbox" means a connected mail account.** It
never names a screen.

Updated 2026-08-23: the tier list below was stale at four (PUSH/QUEUE/SILENT/AUTO)
while the schema had moved to five lanes. Realigned to the schema.

Updated 2026-09-30: added **Key permission** and **Agent activity** (step A3 of
`providers/unified-platform-plan.md`), the two nouns of the MCP write-tools UI.

Updated 2026-10-02: Home is **Today** and the approval surface is **Approvals**
(formerly "Decision queue"); the Firewall board screen is retired as a
user-facing term. Added **Today**, **Assistant**, **Files**, **SourceBadge**.
See `design/productization-plan.md`.

## The nouns

| Term | Means | Where it appears | Never means |
|---|---|---|---|
| **inbox** | One connected mail account (a Gmail account, a Naver IMAP account). A user can have several. | Settings → "Accounts & sources", the source badge on each row, the account facet on Mail (no account switcher — FD-2) | A screen. Not Today, not Approvals, not the lane view. |
| **Today** | The home surface: mail by lane across all connected accounts, the merged calendar, recent files, and an assistant strip. | Sidebar nav (first item), the app's landing view | A mail list or an approval list. Shipping behind `UNIFIED_HOME` (proposed flag); until then `/inbox` is still home. |
| **Assistant** | The nav section holding chat, **Approvals**, Briefing and Receipt. | Sidebar nav | A lane or an agent mode. |
| **Approvals** | The list of things waiting for the user's approval. Formerly the **Decision queue**. | Under Assistant | A mail list. Nothing lands here unless it needs a decision. Transition: the old term "Decision queue" and `/inbox` remain in code until P6/P7 ship behind `UNIFIED_HOME`; new copy uses "Approvals". |
| **Files** | Documents from connected drive sources. | Sidebar nav, only when a drive source is enabled | Mail attachments. |
| **SourceBadge** (source) | The small monochrome glyph showing which connected account a row or event came from. | Every mail row and calendar event | A lane or a category. |
| **Firewall board** | Internal-docs term for the lane classification view. The separate screen is **retired as a user-facing term**: lanes are Mail's primary filter (PUSH / MEETING / QUEUE / INFO / SILENT). `/inbox/firewall` and the desktop tier columns persist in code until migration. | Internal docs only | A place to read mail, and never user-facing copy. |
| **Receipt** | The record of what Klorn did today, after the fact. | `/inbox/receipt`; under Assistant | Something to act on. It is read-only history. |
| **Mail** | The actual message list and reading view; lanes are its primary filter. | `/email`, desktop reading pane | Approvals. |
| **Key permission** | What an MCP API key may do: **Read only** (the default) or **Read and write**. Read and write lets an external agent mark mail as read and change lanes; it never allows send, delete or forward. Offered only while write tools are switched on. | Settings → "MCP API keys": the choice when creating a key, and a label on each key | Agent mode (`SHADOW` / `SUGGEST` / `AUTO`). A key's permission is about which tools an *external* agent may call; it says nothing about how much Klorn's own agent does without asking. |
| **Agent activity** | The per-key history of write actions an external agent took through that key: when, what, and how it ended (Done / Refused / Error / Outcome unknown). | Settings → "MCP API keys", expandable on each Read and write key | The receipt (Klorn's own record of what Klorn did today), or agent mode. It never lists reads, and never shows message content. |

## The lanes

Exactly five, fixed. Never invent a sixth, and never rename one. The
canonical list lives in `packages/api/prisma/schema.prisma` on
`AttentionItem.tier`:

| Lane | Means |
|---|---|
| **PUSH** | Interrupt the user now. |
| **MEETING** | Scheduling mail. Notifies like PUSH, plus a calendar cross-check: proposed slot, conflicts, slots verified free for both sides. |
| **QUEUE** | Worth reading today; no banner. This is the default. |
| **INFO** | Calm transactional record — receipts, confirmations, status notices. Filed; no reply ever expected. |
| **SILENT** | Recorded, never rendered. The row exists for ground-truth feedback. |

### Legacy values

`AUTO` and `CALL` are **v1 tiers, retired**. Rows written before v2 still
carry them and are folded into the live lanes by `normalizeTier` on read.
Never emit them from new code, and never show them in UI copy.

`AUTO` in particular was the value users misread most — it meant "Klorn was
confident enough not to ask," a *classification*, never "Klorn replied for
me." Any copy implying a lane acts on its own is wrong, which is why the
desktop ships a lane guide.

## Two different "language" settings

They are not the same knob, and conflating them produces a Korean reply
announced by an English banner:

- **App language** — the UI chrome of one client. Local to that client (the Mac
  reads macOS's language; the web has its own setting).
- **Notification language** — the language Klorn writes *its own* notifications
  in ("Draft ready"). Server-side (`AutomationConfig.notificationLanguage`),
  because a push is composed on the server where there is no client locale.
- **Reply language** — not a setting at all. A reply always follows the
  language of the mail it answers.

## Two different "auto"

Also distinct, also easy to conflate:

- **AUTO (retired lane)** — a v1 classification label. Took no action, and
  no longer exists in new writes. See "Legacy values" above.
- **Agent mode = AUTO** — how much the agent may do without asking
  (`SHADOW` / `SUGGEST` / `AUTO`). Even here, sending mail is excluded from
  pre-approval on purpose: a bad auto-reply costs more trust than the saved
  click is worth.

## Rule

If a new surface needs a name, take it from this table or add a row here first.
The cost of two words for one thing is a user who can't tell what they're
looking at.
