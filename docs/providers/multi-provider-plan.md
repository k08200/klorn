# Multi-provider mail plan (Gmail · Naver · iCloud · Outlook · generic IMAP)

Decided 2026-08-05. Goal: 3–4 mail accounts per user, any mix of providers,
managed in one firewall across web/mobile/desktop. This file is the sequenced
plan; each phase is a separate PR train and each later phase depends on the
earlier ones.

Sequencing after Phase 3, and calendar, drive, agent and company-edition work,
is in `unified-platform-plan.md` (2026-09-28). Phase 4 stays defined here.

## Where the code actually is (audited 2026-08-05)

- No provider interface. The sync/action pipeline is hard-wired to Gmail
  (`mail/email-sync.ts` imports googleapis directly; `source: "gmail"` is a
  fixed literal). Naver is a parallel, hand-rolled ingestion path
  (`mail/naver-imap.ts`) that co-opts `gmailId` as `naver-imap:<email>:<uid>`
  and reuses only the judge core.
- Naver is **read-only** (zero send/archive/mark-read functions) and
  **single-account by schema** (four flat columns on `User`; a second connect
  overwrites the first).
- `LinkedInboxAccount` was Google-OAuth-shaped with no provider column
  (fixed in Phase 0a).
- The action surface has no interface boundary: 8+ mutation functions live in
  `mail/gmail.ts` and every caller imports them by name
  (`agentcore/tool-executor.ts`, routes/email-*.ts).
- Auto-reply is primary-Gmail-only even for linked Gmail accounts
  (`automation-scheduler.ts` filters `linkedInboxAccountId: null` on purpose —
  per-account send routing does not exist yet).
- The wire contract has no provider concept: `EmailListResponse.source` is
  `"gmail" | "demo"`, and Naver rows are reported as `"gmail"`.
- The IMAP SSRF allowlist is deliberately a single exact host
  (`mail/is-allowed-imap-host.ts`). iCloud is a one-line addition; generic
  IMAP is a different security design, not an extension.

Blast radius of the full effort: ~60 API files reference Gmail, 24 thread
`linkedInboxAccountId`, ~18 web files, plus one load-bearing contract type.

## External constraints (verified 2026-08-05)

| Provider | Reality |
|---|---|
| Outlook | Basic-auth IMAP retired for outlook.com (Mar–Apr 2026). OAuth only, via Microsoft Graph (`Mail.Read/ReadWrite/Send`, delta queries, change-notification webhooks). Azure app registration required; the verified-publisher badge requires an **organizational tenant** (personal-account registrations cannot get it). From 2026-12-31, editing a delivered message's subject/body/recipients needs `Mail-Advanced.ReadWrite` — Klorn only flags/moves/marks, so standard scopes should suffice; re-verify at implementation. |
| iCloud | No OAuth. IMAP `imap.mail.me.com:993` / SMTP `smtp.mail.me.com:587` with an **app-specific password** (requires 2FA on the Apple ID). UX must walk the user through generating one. |
| Generic IMAP | Technically easy, security-hard: accepting arbitrary hosts is exactly what the allowlist exists to prevent. Needs DNS-resolution-time private-IP blocking (rebinding-safe) before it can ship. |

## Phases

**Phase 0a — provider-aware schema (this PR).** `InboxProvider` enum +
`provider` column (default GOOGLE backfills), `accessToken` nullable,
`imapHost`/`imapPasswordCipher` columns, dedup key gains provider.
`mail/inbox-credentials.ts:inboxAuthKind()` is the single provider→credential
mapping. No behavior change.

**Phase 0b — Naver moves into LinkedInboxAccount.** Data migration from the
four `User` columns to a `provider: NAVER` row; `naver-imap.ts`/scheduler/
routes read the table. Side effect: Naver becomes multi-account. The `User`
columns are dropped one release later (expand/contract).

0b's provider-filter audit list (from the 0a security review — every
`linkedInboxAccount` call site that reads without a provider filter today;
safe while all rows are GOOGLE, each must be scoped or generalized the moment
NAVER rows exist): `mail/gmail.ts:742,786,821,1629,1684,1725`,
`mail/email-sync.ts:122,144,343`, `automation-scheduler.ts:1054`,
`routes/email.ts:1151,1181`, `scripts/reencrypt-tokens.ts:143,147`.
(`routes/gmail-push.ts` was already scoped to GOOGLE in 0a.)

0b outcome (landed): the audit list's real exposures were closed — the OAuth
fan-outs, watch renewal, the Google linked-inboxes list/delete routes, the
Google link cap, and `/api/email/inboxes` are provider-scoped to GOOGLE; the
by-`{id,userId}` writes were verified safe (their ids come from GOOGLE-scoped
selections upstream) and left unfiltered. The key-rotation sweep now covers
`imapPasswordCipher`. Naver sync stamps `linkedInboxAccountId` on every
EmailMessage (legacy rows adopt it as the poll re-touches the recent window).

Deferred to Phase 1, with reasons:
- `notify/reconnect-notification.ts` Gmail-branded copy/dedupe key: still
  unreachable for NAVER rows — the naver sync path does not yet flag
  `needsReconnect` on auth failure (failures log + count only). Generalize the
  copy WHEN that flagging lands, as one change.
- `/api/naver-imap/status` returns `needsReconnect` per account but it can
  only be false today, for the same reason.
- The `User.naverImap*` columns still exist (stale, unread). Drop via a
  contract migration after this release proves out.

**Phase 1 — MailProvider interface.** Extract ingestion
(fetch→normalize→upsert→judge, the shape `naver-imap.ts` already proves) and
actions (send/archive/markRead/trash/star) behind one interface;
`tool-executor` dispatches by provider; per-account send routing lands here
(also unlocks auto-reply for linked Gmail accounts). Contract gains a real
`provider` field on `InboxOption`/list responses.

**Phase 2 — iCloud.** Allowlist + app-specific-password connect UX on the
generalized IMAP path. Smallest new provider; validates Phase 1.

Phase 2 outcome (landed): `imap.mail.me.com` joined the exact-host allowlist,
and the Naver-named IMAP path became provider-parameterized — `imap-sync.ts` /
`imap-accounts.ts` / `imap-scheduler.ts` / `routes/imap-connect.ts` (a
per-provider route factory), driven by the `IMAP_PROVIDERS` registry in
`mail/imap-providers.ts`. Naver behavior, URLs, and the persisted `naver-imap:`
dedup prefix are unchanged; iCloud uses `icloud-imap:`. The connect route now
also pins host↔provider (the shared allowlist alone would let a NAVER row point
at the iCloud host). Everything iCloud is dark behind `ICLOUD_INBOX_ENABLED`
(dynamic, default OFF): the `/api/icloud-imap/*` routes answer 404 — even
unauthenticated — and the poll never selects ICLOUD rows, so the CASA/DAST
surface is unchanged until the flag flips. iCloud is read-only (ingest + judge;
actions stay 501 via `unsupportedMailActions`), same as Naver. The scheduler
heartbeat renamed `naver-imap` → `imap` (one scheduler, all IMAP providers).

**Phase 3 — Outlook.** Azure app registration (founder action), Graph OAuth
connect, delta-query sync, Graph-API actions, change-notification webhook (or
poll first, webhook later).

Phase 3 progress — 3A (connect surface) landed:
`/api/auth/outlook/{link-inbox,callback,linked-inboxes}` mirrors the Google
link flow (state-JWT CSRF, TOCTOU entitlement re-check at the callback,
new-links-only cap of 10), dark behind `OUTLOOK_INBOX_ENABLED` via the shared
`darkRouteGate` (extracted from the iCloud gate). Token exchange is plain
fetch against login.microsoftonline.com (no msal dependency); delegated
scopes `Mail.Read/ReadWrite/Send` + `offline_access`. Re-verified 2026-08-06:
the 2026-12-31 `Mail-Advanced.ReadWrite` requirement covers subject/body/
recipient edits on delivered mail only — Klorn never does those, standard
scopes suffice; note some org tenants require admin consent for
`Mail.ReadWrite` (personal accounts consent directly). Founder action before
any real link: Azure app registration (supported account types: personal +
work/school), then `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_REDIRECT_URI`
(prod callback `https://klorn-api.onrender.com/api/auth/outlook/callback`) in
Render. Phase 3 complete pending the founder's Azure app registration.

3D (web UI) landed: `OutlookInboxesSection` in settings mirrors the Google
linked-inboxes section (list / OAuth link / unlink via /api/auth/outlook/*),
renders nothing while the list probe 404s (flag off — same dark pattern as
the iCloud section, no NEXT_PUBLIC flag), and defers the shared ?inbox=
redirect toast/strip to the Google section to avoid effect races. Flipping
OUTLOOK_INBOX_ENABLED requires the Azure registration first: without
MS_CLIENT_ID/MS_CLIENT_SECRET the link-start endpoint answers 503 by design.

3C (actions) landed: `mail/providers/outlook.ts` implements the full
`MailProviderActions` surface via Graph (PATCH isRead/flag, moves to the
well-known deleteditems/archive/inbox folders, sendMail with base64
fileAttachments, draft creation) and the dispatch registry routes OUTLOOK to
it — the 501 refusals are gone. Every request carries
`Prefer: IdType="ImmutableId"` so the ids stored by the sync resolve after
folder moves; the Graph id is extracted from the synthesized
`outlook:<email>:<id>` key. Token lifecycle moved to `mail/outlook-token.ts`
(shared by poll + actions without dragging the ingestion chain into the
action import graph). Result contract, deliberately mirroring Gmail's:
`{error}` ONLY for the not-connected class (missing linked id, unresolvable
bearer, Graph 401/403 — which also durably flag reconnect); EVERYTHING else
(non-auth 4xx incl. 429, foreign/corrupt message ids, 5xx, network) throws —
callers' `{error}` fallback is a local-only write, and for DELETE that means
false-success + resurrection on the next delta sync. Reply threading
deferred: Graph sendMail cannot set In-Reply-To, so `getReplyHeaders`
answers `{}` (best-effort per contract) to keep `/reply` from claiming
`threaded: true`; real threading needs the /messages/{id}/reply endpoint.

3B (ingestion) landed: `mail/outlook-{sync,accounts,scheduler}.ts` mirror the
IMAP trio — Graph delta query against the inbox folder, every message through
the shared persist path with dedup key `outlook:<email>:<immutable id>`.
Load-bearing details: `Prefer: IdType="ImmutableId"` (default Graph ids CHANGE
on folder moves — archive would re-ingest everything) and
`outlook.body-content-type="text"`. The delta cursor (delta/next link) lives
in `LinkedInboxAccount.historyId` — the provider-generic sync watermark, same
co-opt precedent as gmailId; page-capped ticks store whichever link they
stopped at, so large first syncs catch up incrementally and 429s resume in
place. Cursor URLs are only ever followed on graph.microsoft.com (a tampered
row must not aim the bearer token elsewhere). Token refresh handles
Microsoft's refresh-token ROTATION (new cipher persisted each grant); every
auth-failure path (undecryptable cipher, invalid_grant, Graph 401/403) flags
`needsReconnect` via the now provider-parameterized reconnect alert
(`reconnect:outlook:` dedupe keys, Outlook-branded copy — the 0b deferred
"generalize the copy when flagging lands" item, done here). Scheduler
heartbeat name `outlook`; the tick no-ops while OUTLOOK_INBOX_ENABLED is off.

**Phase 4 — generic IMAP.** Only after the SSRF design (resolve-then-pin,
private-range rejection) passes security review. OFF flag until then.

## Cross-cutting rules

- Every phase ships **OFF by default** (repo doctrine) and stays off until the
  CASA Letter of Assessment is issued — the TAC DAST scans production before
  2026-10-05, and new auth/IMAP endpoints must not widen that surface mid-scan.
- The 100-user cohort does not wait for any of this: it runs on Gmail today.
- No new Google scopes at any phase — nothing here reopens Google verification.
