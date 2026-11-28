# Mail cleanup actions: delete, archive, spam, block, unsubscribe

Status: **decided** by the founder on 2026-11-28 ("정해야 하는 건 권고대로": every
open decision takes the recommended option). This file is the canonical record
for the PR sequence below. Code catches up PR by PR; until a row in
[PR sequence](#pr-sequence) says "shipped", the product behaves as the code
says, not as this file says.

## Request

Delete, clean up, report spam, block a sender and unsubscribe must work inside
Klorn on every surface (web, Windows, mobile, Mac) and by asking the chatbot.

## What existed on 2026-11-28 (origin/main 0a116e30)

- **Unsubscribe** (#1280): header parser `mail/list-unsubscribe.ts`, RFC 8058
  one-click POST, the `EmailMessage.listUnsubscribeMailto/Url/OneClick`
  columns, `POST /api/email/:id/unsubscribe`, the Subscriptions page (dark
  behind `BULK_UNSUBSCRIBE_ENABLED`), shared `mail/unsubscribe-action.ts`. IMAP
  and Outlook never fetch the header.
- **Agent**: `archive_email` / `delete_email` exist only in the risk table
  (`agentcore/agent-logic.ts`); no tool definition, and the executor answers
  "Unknown function".
- **Chat**: read-only tools plus event drafts. The only write (`create_event`)
  is intercepted into an `eventDraft` card. PendingAction cards come only from
  the autonomous agent; their approve route is Pro-gated.
- **Web**: v2 row actions are archive / lanes / later; the reader's More menu
  has Delete (with confirm) and Unsubscribe when a header was parsed; bulk is
  archive only, ≤100, Gmail calls one at a time. Swipe mapping (right = Done,
  left = Later) is LOCKED since 2026-11-14.
- **Mac**: no delete, spam, block or unsubscribe. Done dismisses the attention
  item; the mail stays. No ⌘Z.
- **Telegram** buttons are only `ovr:QUEUE/SILENT`. **MCP** writes are
  mark_read / set_tier / create_draft behind `MCP_WRITE_TOOLS_ENABLED`, and its
  vocabulary "never send / delete / forward" stays.
- **Block** today is Screener BLOCK → `PIN_TIER SILENT` (`SCREENER_ENABLED`
  off) or `POST /:id/pin-tier` SILENT. Mail never moves.
- `EmailRuleAction` ARCHIVE / LABEL / NOTIFY are stored, but only AUTO_REPLY
  and DRAFT_REPLY run.
- **Providers** (seam `mail/providers/types.ts`): Gmail trash / archive work;
  Outlook moves work; IMAP moves are behind `IMAP_MOVE_ACTIONS_ENABLED` (off,
  else 501) and need SPECIAL-USE folders; KLORN is unsupported. No spam action
  anywhere.

## Bugs found (fixed in PR1 unless marked)

1. Outlook single trash / archive left the row in Klorn: the route assumed the
   provider deleted it (Gmail and IMAP do, Outlook's Graph move does not), and
   the Outlook delta skips `@removed`.
2. Undo of linked Gmail and Outlook mail failed: the web sent only `gmailId`,
   the server recovered the account only for IMAP, and an Outlook undo
   re-synced through the Gmail path.
3. Single archive / trash left the attention item OPEN (only bulk resolved
   it), and `/api/inbox/firewall` listed items whose row was gone, so deleted
   mail kept showing on Mac PUSH.
4. A partly failed web bulk archive restored every row and dropped the undo of
   the rows that did leave.
5. Archived spam came back: the spam lane (`SPAM_INTAKE_ENABLED`, default on)
   re-reads the newest `in:spam` each tick, and archiving a spam row is an
   INBOX-removal no-op plus a row delete. **PR2** (spam-lane suppression).
6. The unsubscribe link fallback used `window.open`, a silent no-op in the
   Tauri and Capacitor shells, with a success toast.
7. Swallowed failures: a failed one-click fell through silently; the POST sent
   no User-Agent; the mailto unsubscribe was sent with no receipt; the known
   reason list said `request-failed` where the code returns `request-error`.

## Constraints

- **Google scopes are frozen**: gmail.readonly, gmail.send, gmail.modify,
  calendar.events, calendar.readonly (pinned by
  `google-auth-urls-pinned.test.ts`). No permanent delete (needs
  mail.google.com), no Gmail filters (gmail.settings.basic). Spam is the SPAM
  label through messages.modify, inside gmail.modify. The privacy page gets
  new wording for the same scope; no new scope.
- **Microsoft**: User.Read, Mail.Read, Mail.ReadWrite, Mail.Send. Junk and
  Deleted Items moves are allowed; inbox rules need MailboxSettings.ReadWrite
  (not granted), so a block is enforced in Klorn. Immutable ids are in use.
- **Approval floor** `FLOOR_ACTIONS = [send_email, delete_permanent,
  forward_external]`: archive and trash are not gated. A mailto unsubscribe is
  a send and takes a send receipt (`openSendReceipt`, route "unsubscribe").
- **Guards** every new route and table meets: address-log, caught-error-text,
  db-failure-redaction, ownership-not-found (404, never 403), cohort-gate (new
  route files listed), rls-coverage and data-wipe-fence (new tables),
  like-pattern (`escapeLikePattern`).
- **Learning**: archive / trash / unsubscribe stamp engagement columns only; a
  sender-wide action is not stamped; a block writes a rank-0 PIN only from a
  user's own confirmation (set_tier pollution rules in
  `docs/providers/unified-platform-plan.md`).
- A block resolves at judge rank 0 (PIN SILENT): it never pushes and never
  spends budget.
- **Quota / CPU**: Gmail batchModify (≤1000 ids, 50 units); Graph $batch ≤20,
  ~4 concurrent per mailbox; Render runs on 0.1 CPU, so more than 100 goes
  through the scheduler in chunks.
- **SSRF**: one-click goes through `isSafePushEndpoint` and
  `ssrfSafeHttpsAgent`, follows no redirect, 10 s timeout, and (PR1) port 443
  only.

## Design

1. **One action service** `mail/mail-actions.ts` for every surface:
   `trash | archive | spam | not_spam | unsubscribe | block | unblock` plus
   undo. It always uses the row's stored `linkedInboxAccountId`, resolves
   attention items, writes the ledger, stamps learning only for explicit user
   id selections (never selector-wide), and chunks per provider (Gmail
   batchModify ≤500 per call, Outlook ≤4 concurrent with 429 backoff and
   resumable batches, IMAP coalesced).
2. **Provider seam** `markSpam / unmarkSpam`: Gmail +SPAM −INBOX and the
   reverse; Outlook move to `junkemail` / `inbox`; IMAP `\Junk` move role
   behind `IMAP_MOVE_ACTIONS_ENABLED`; KLORN 501 until E2.
3. **Plans** for selector and chat actions: a server-side dry run, scoped to
   the user, answers a planId, the count, the top senders and a sample. Execute
   needs the planId (idsHash pinned, 15-minute expiry, single use; mismatch or
   expiry → 409). A selector needs at least one narrowing filter, excludes
   starred mail by default, is capped at 1000, and filters by lanes,
   from / fromDomain (exact; public mailbox domains refused via
   `isPublicMailboxDomain`), older-than / received range, list mail /
   promotional, and account.
4. **Block**: `SenderBlock` (mode SPAM by default, or TRASH / ARCHIVE) plus a
   `PIN_TIER SILENT` rule "Block: …"; enforced in the shared post-judge persist
   hook (`judge/email-firewall.ts`, shared by all providers); mail moved by a
   block is logged per user and day as a restorable batch; the spam-lane sweep
   skips blocked senders and Klorn-moved ids; a daily receipt says "N moved by
   your blocks".
5. **Spam-lane suppression**: `syncSpamLane` and persist skip provider ids with
   a live (not undone) `MailActionItem` from the last 30 days. Fixes bug 5.
6. **Unsubscribe**: IMAP fetches `list-unsubscribe` and
   `list-unsubscribe-post`; Outlook reads `internetMessageHeaders` lazily on
   reader open or action and caches it in the existing columns; mailto through
   `openSendReceipt` (route "unsubscribe"); one-click with a User-Agent, port
   443 and host caps for bulk; every unsubscribe is logged "not undoable".
7. **Undo** through the ledger with the stored account: trash → untrash,
   archive → unarchive, spam → not spam, block → unblock (moved mail
   restorable per batch); unsubscribe has no undo and the UI says so; the
   restore re-sync reuses the stored lane (no fresh LLM judge).

### Chat tools (`CHAT_MAIL_ACTIONS_ENABLED`) — nothing executes from the model loop

- `find_mail(selector)`, read-only: count, top senders, sample; untrusted text
  wrapped.
- `propose_mail_action({action, selector | email_ids | "current_email", mode?,
  apply_to_existing?, also_archive?})` → a `MailActionPlan` with source CHAT, a
  summary, and `ChatTurnResult.mailActionDraft` (the same interception as
  `eventDraft`).
- `undo_last_mail_action()` → a card.
- Prompt: never claim it is done; dates through `get_current_time`; refuse
  "everything".
- Examples: "이 발신자 차단해" / "block this sender" / "屏蔽这个发件人" → block the
  current sender, mode spam, apply to existing; "광고 메일 전부 정리해" / "clean up
  all promotions" / "把广告邮件都清理掉" → archive {promotional, lanes
  INFO/SILENT}; "이거 스팸 신고" / "report this as spam" / "把这封举报为垃圾邮件" →
  spam the current mail; "구독 취소해줘" / "unsubscribe me" / "帮我退订" →
  unsubscribe (the card shows the method; a mailto shows the account); "어제 온
  링크드인 메일 다 삭제" / "delete all LinkedIn mail from yesterday" /
  "把昨天领英的邮件全部删除" → trash {fromDomain linkedin.com, received yesterday in
  the user's time zone}; "방금 거 되돌려" / "undo that" / "撤销" → undo the last
  batch.
- Confirm: web chat and the assistant dock card (Confirm / Cancel); Telegram
  inline `mpl:<uuid>:y|n` (64 bytes), checked against the linked chat and the
  plan's owner; Mac shows "confirm in Klorn" until PR7; MCP unchanged.

### Data model (expand-only; RLS on and data-wipe fence for each table)

- `MailActionPlan`: id, userId, action, selector Json, emailIds[], idsHash,
  count, source (UI / CHAT / TELEGRAM / MAC), conversationId?, expiresAt,
  consumedAt?, batchId?
- `MailActionBatch`: id, userId, action, source, planId?, status,
  requested / succeeded / failed, undoExpiresAt, undoneAt, createdAt
- `MailActionItem`: batchId, userId, emailId, providerMessageId,
  linkedInboxAccountId?, provider, priorTier?, status, failureCode?,
  restoredMessageId?; index (userId, providerMessageId); purged after 30 days
- `SenderBlock`: userId, scope (SENDER / DOMAIN), value, mode,
  linkedInboxAccountId? (null = all), pinRuleId?, source, appliedCount,
  lastAppliedAt; unique (userId, scope, value)
- Optional `DecisionLabel.reportedSpamAt` and `blockedAt` engagement columns.
  Contract `EmailListItem.unsubscribe` method.

### API

New routes answer the envelope `{ success, data?, error?, code? }`; existing
routes stay byte-identical for the Mac app; all are rate limited; a foreign id
is a 404.

- `POST /api/email/actions` {action, ids ≤100 | planId}
- `POST /api/email/actions/plan`
- `POST /api/email/actions/:batchId/undo`
- `GET /api/email/actions`
- `GET|POST|DELETE /api/email/senders/blocks`
- `POST /api/email/senders/unsubscribe` {sender | emailId, alsoArchive,
  alsoBlock}
- `POST /api/email/actions/plans/:id/confirm|cancel`

### Flags

off / cohort / on, default off, exposed through `/me` like `user.mailV2`:
`MAIL_CLEANUP_ENABLED`, `MAIL_SPAM_ACTIONS_ENABLED`, `SENDER_BLOCK_ENABLED`,
`CHAT_MAIL_ACTIONS_ENABLED`, `LIST_UNSUBSCRIBE_ALL_PROVIDERS`;
`BULK_UNSUBSCRIBE_ENABLED` becomes cohort-capable.

### UI

- **Web / Windows / mobile**: row menu and phone sheet get Delete, Report spam,
  Block sender…, Unsubscribe (swipes unchanged); the selection bar gets Delete,
  Spam and "Select all from this sender"; the INFO / SILENT lane header gets
  "Clean up…" with older-than chips; the reader header gets Unsubscribe for
  list mail, Spam / Block in More; Subscriptions gets a per-row Block and
  multi-select; Settings → Blocked senders; "Recently cleaned" with Restore per
  batch.
- **Mac**: reading-pane toolbar and list context menu get Archive, Delete,
  Report spam, Block sender, Unsubscribe; ⌘⌫, ⇧⌘J; ⌘Z batch undo; an assistant
  card for chat plans.
- **Unsubscribe confirm**: in the UI a one-click button is the confirmation;
  bulk and chat show a card per sender saying it cannot be undone; a mailto
  always shows the recipient, the account and the receipt.

UI conventions from the design session (2026-11-28) for PR3:

- The design session is not redesigning the mail-cleanup entry surfaces;
  build on the merged layouts.
- Phone row sheet `app/email/_v2/row-action-sheet.tsx` (bottom sheet from the
  44 px "More" button): add Delete / Report spam / Block sender / Unsubscribe
  as 44 px rows, destructive items last, with confirm.
- Swipes (`app/email/_v2/row-actions.ts`, `mail-list.tsx`) unchanged.
- Rows: `components/ui/mail-row.tsx` `variant="brief"`,
  `components/ui/monogram-avatar.tsx`, `components/ui/toggle-chips.tsx`,
  `app/email/_v2/lane-chips.tsx`.
- The INFO / SILENT "Clean up…" action goes in `mail-header.tsx` near the
  lane chips; on phone (<600, `max-rail:`) a 44 px target, not inside the
  scrolling chip track.
- Reader: `app/email/[id]/_v2/reader-v2.tsx` (the top-bar More menu holds
  secondary actions on phone); the phone bottom bar in `reader-actions.tsx` is
  exactly three buttons (Reply · Later · Done), so Delete / Spam / Block go in
  the More menu, never the bar.
- Overlays: `components/ui/sheet.tsx`, `components/ui/overlay-portal.tsx`
  (portal at z-[120], above the tab bar and the K button) for confirm cards and
  sheets, `components/ui/menu.tsx` `tall` for 44 px items.

## Founder decisions — LOCKED 2026-11-28

1. Block destination: Spam (per-block option Trash / Archive).
2. Block scope: all connected accounts.
3. Sender-exact by default; a domain block is allowed except for public
   mailbox domains.
4. A block also moves existing mail: a checkbox, on by default.
5. Unsubscribe also archives existing mail by default; block is offered
   separately (RFC 8058 lists may take up to 2 days).
6. Chat: a confirm card for every mutating action (N ≥ 1); the only exception
   is the undo of the user's own last batch.
7. Delete = Trash (30 days, no permanent delete). A single mail: no confirm
   (undo instead). Confirm when more than 20, or when selector-based.
8. Mac Done = archive for mail items (like web) plus ⌘Z; dismiss stays for
   non-mail items.
9. v1 acts on the mail Klorn holds; v2 adds a Gmail-side search for "all mail
   from X".
10. The spam lane (default on) stays; add Not spam / Keep in spam; suppress
    what was reported.
11. Chat bulk unsubscribe: ≤20 senders per card, one-click only; a mailto is
    confirmed per sender.
12. Mail actions are free in the UI and in chat: the new plan-confirm route is
    NOT Pro-gated (the existing PendingAction approve stays as is).
13. No Spam button on Telegram PUSH notifications; Telegram buttons only for
    chat plans.

## PR sequence

| # | PR | Mac release? | Status |
|---|---|---|---|
| PR1 | Fix the existing paths, no flag: undo names the account; Outlook single trash / archive deletes the row, Outlook undo restores through Graph; single archive / trash resolve attention, and the firewall list drops items whose mail is gone; `openExternal` for the unsubscribe link; a partly failed bulk archive keeps the undo of what left; unsubscribe reports skipped methods, User-Agent, port 443, mailto receipt | No | in review |
| PR2 | Ledger, action service, spam seam, `/api/email/actions` routes, plans, spam-lane suppression, privacy copy (`MAIL_CLEANUP_ENABLED`, `MAIL_SPAM_ACTIONS_ENABLED`) | No | planned |
| PR3 | Web UI: Delete / Spam in rows, sheet and bulk bar; lane cleanup sheet; Recently cleaned; en / ko / zh | No | planned |
| PR4 | Sender block (`SENDER_BLOCK_ENABLED`) | No | planned |
| PR5 | Unsubscribe everywhere (IMAP header, lazy Outlook headers, unsubscribe + archive (+ block), host caps, cohort Subscriptions) | No | planned |
| PR6 | Chat mail actions (`CHAT_MAIL_ACTIONS_ENABLED`) and Telegram `mpl:` buttons | No | planned |
| PR7 | Mac toolbar, context menu, shortcuts, ⌘Z, assistant card, Done = archive for mail | Yes | planned |
| PR8 | Agent risk-table `archive_email` / `delete_email` through the action service (HIGH-risk PendingActions) or removed; EmailRule ARCHIVE executes or is hidden; optional Today "clean up N promotions" | No | planned |

Order: PR1 → PR2 → PR3 → (PR4 ∥ PR5) → PR6 → PR7 → PR8.

## Risks

- **Prompt injection**: the selector is resolved server-side, with narrowing
  rules and caps, and the card shows the count and a sample.
- **Learning pollution**: only user-confirmed blocks write a rank-0 PIN; the
  Blocked senders page shows them.
- **Block latency**: enforced in Klorn after a sync; copy must say so.
- **Wrong-account writes**: every action and undo uses the row's stored
  account.
- **Spam-lane resurrection**: suppression through the ledger (PR2).
- **Bulk cost**: undo re-judging (PR2 reuses the stored lane), Outlook 429
  (resumable batches), more than 100 chunked through the scheduler.
- **One-click is irreversible**; the port is pinned to 443 (PR1).
- **Privacy copy** changes, the scopes do not.
- **Retention**: data-wipe fence and a 30-day purge for the ledger items.
- **Mac lag**: a text notice until PR7; the existing Mac endpoints are
  unchanged.
