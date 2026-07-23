# Limited Use Compliance — Declaration Draft and Privacy-Policy Gap Analysis

## Part 1 — Limited Use compliance declaration (paste-ready)

> Klorn's use and transfer to any other app of information received from
> Google APIs will adhere to the
> [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
> including the Limited Use requirements.
>
> Specifically, for all Gmail and Calendar data accessed via the requested
> scopes:
>
> 1. **Use is limited to user-facing features.** Google user data is used
>    only to provide and improve Klorn's visible features: classifying
>    messages into attention tiers (PUSH / QUEUE / SILENT / AUTO),
>    summarizing messages and generating daily briefings, reflecting the
>    user's triage decisions back into Gmail (labels, read state, archive,
>    reversible trash), sending user-approved replies, and providing
>    calendar-aware context (conflict detection, event capture). No other
>    use is made of this data.
> 2. **No advertising.** Klorn does not use Google user data for serving
>    advertisements, including retargeting, personalized, or
>    interest-based advertising, and never will.
> 3. **No human access.** No human reads Google user data except the user
>    themselves through the product UI. Klorn's operators do not read user
>    mail or calendar content, except with the user's affirmative agreement
>    for a specific support case, where necessary for security purposes
>    (e.g. abuse investigation), or to comply with applicable law.
> 4. **No sale or unauthorized transfer.** Klorn does not sell Google user
>    data and does not transfer it to third parties except sub-processors
>    necessary to provide user-facing features (hosting and AI model
>    providers acting on Klorn's instructions, under terms prohibiting
>    training on the data), to comply with applicable law, or as part of a
>    merger/acquisition with prior notice to users.
> 5. **No generalized AI/ML training.** Google user data is never used to
>    develop, improve, or train generalized or non-personalized AI/ML
>    models. AI processing is per-message and per-request, solely to
>    produce the classification, summary, or draft the user sees, via
>    provider API terms that exclude training.
> 6. **Security safeguards.** OAuth tokens are encrypted at rest with
>    AES-256-GCM. All database access uses parameterized queries and is
>    scoped to the requesting user (row-level tenancy). Google user data
>    resides only in Klorn's first-party database — no third-party
>    analytics or trackers receive it. Irreversible mail actions (send /
>    delete / forward) execute only against a cryptographic receipt of the
>    user-approved payload. Webhook ingestion is authenticated, and
>    per-user server-side cost caps bound automated processing.
> 7. **Deletion.** Users can disconnect Google access at any time (and via
>    myaccount.google.com/permissions) and can delete their account, which
>    purges all Google-derived data from Klorn's systems.

## Part 2 — Gap analysis vs. the live privacy page

Reviewed against `packages/web/src/app/privacy/page.tsx` (live at
`app.klorn.ai/privacy`, "Last updated: May 4, 2026").

### Already compliant (keep as-is)

- **Limited Use paragraph** (page.tsx:156-178): contains the required
  verbatim adherence sentence, the no-ads / no-human-access / no-transfer /
  no-AI-training commitments. This is the load-bearing requirement and it
  is present.
- **AI processing disclosure** (page.tsx:223-233): per-request processing,
  no model training — matches Limited Use item 5.
- **Revocation + deletion contact** (page.tsx:201-220, 235-249): revoke link
  to Google permissions, deletion request channel.
- **No sale / no ads statement** (page.tsx:147-151).

### Gaps to fix before submission (reviewers cross-check scope list vs. policy)

> **적용 완료 2026-07-23** — Gaps 1, 2, 3, 7 applied to
> `packages/web/src/app/privacy/page.tsx` (full 8-scope list incl. `gmail.send`,
> `gmail.modify` attribution fixed, `calendar.readonly` + secondary-account
> linking disclosed, concrete Security claims, product description updated to
> attention firewall; "Last updated" bumped to July 23, 2026). Gaps 4, 5, 6, 8
> (retention windows, affirmative self-service deletion, named sub-processors,
> contact address) remain open.

1. **[적용 완료 2026-07-23] Scope list is incomplete and partially misattributed**
   (page.tsx:180-198). The page lists only `gmail.readonly`,
   `gmail.modify`, `calendar.events` — but the app requests **8 scopes**.
   Missing: `gmail.send` (a *restricted* scope — its absence is the most
   likely rejection trigger), `calendar.readonly`, `openid`,
   `userinfo.email`, `userinfo.profile`. Also, the `gmail.modify` bullet
   says it is used to "send replies" — sending is `gmail.send`, not
   `gmail.modify`; fix the attribution and give `gmail.send` its own bullet
   ("send replies only after your explicit approval"). Add a
   `calendar.readonly` bullet: "check availability across all your
   calendars to detect conflicts; read-only, and the only scope requested
   when you link a secondary account's calendar."
2. **[적용 완료 2026-07-23] Secondary-account linking is not disclosed.** The app supports linking
   a second Google account as calendar-only (`calendar.readonly`) or as a
   full inbox (Gmail scopes). The policy's "Data We Collect" should state
   that each linked account grants only the scopes shown at its own consent
   screen.
3. **[적용 완료 2026-07-23] Security section is too vague for a restricted-scope review**
   (page.tsx:251-257). "Access controls, authentication, and operational
   safeguards" says nothing concrete. Add: OAuth tokens encrypted at rest
   (AES-256-GCM), TLS in transit, per-user data isolation, no third-party
   trackers on Google user data.
4. **No concrete retention periods** (page.tsx:235-249). "While your
   account is active" is acceptable, but CASA and reviewers prefer
   specifics: state that operational logs are retained on a fixed schedule
   (a log-retention job exists — mirror its actual windows), and that
   account deletion purges all Google-derived data promptly (state the
   timeframe, e.g. "within 30 days").
5. **Self-service deletion is understated** (page.tsx:240-248). The policy
   says authenticated users may use in-product deletion "where available"
   — the self-service deletion route exists and is a review requirement;
   say so affirmatively ("You can delete your account and all associated
   data from Settings at any time").
6. **Sub-processor disclosure.** The AI Processing section mentions "AI
   model providers" generically. Name the categories (hosting/database, AI
   inference) — naming exact vendors is better still, since the AI layer
   is multi-provider.
7. **[적용 완료 2026-07-23] Stale product description** (page.tsx:98-104): "work Decision OS"
   predates the attention-firewall positioning. The consent-screen app
   description, homepage, and privacy policy should describe the product
   identically — reviewers flag mismatches.
8. **Contact address consistency** (page.tsx:206, 242, 262): the policy
   uses a personal Gmail address (`k0820086@gmail.com`). Acceptable, but
   the same address must be entered as the support email on the consent
   screen; a domain address (e.g. `privacy@klorn.ai`) reads far stronger
   for a restricted-scope app.

### Suggested policy additions (draft language)

Add to the scope list in the "Google User Data" section:

> - `gmail.send` — send a reply only after you explicitly approve it. Every
>   send is verified against a receipt of the exact content you approved.
> - `calendar.readonly` — check availability across all your calendars to
>   detect scheduling conflicts. When you link a secondary Google account
>   for calendar visibility, this read-only scope is the only calendar
>   access requested for it.
> - `openid`, `userinfo.email`, `userinfo.profile` — sign you in and show
>   which Google account is connected.

Add to the "Security" section:

> Google OAuth tokens are encrypted at rest using AES-256-GCM. All data
> access is scoped to your account, transport is TLS-encrypted, and your
> Google user data is stored only in Klorn's own database — it is not
> shared with analytics or advertising services.

<!--
CODE EVIDENCE (strip before submission)
- Privacy page reviewed: packages/web/src/app/privacy/page.tsx (line refs inline above;
  scope bullets :182-198, Limited Use :156-178, Security :251-257, updated date :9).
- Actual 8-scope set: packages/api/src/mail/gmail.ts:66-78; secondary calendar link :95-99;
  secondary inbox link :118-124 (disclosure gap #2).
- AES-256-GCM: packages/api/src/crypto-tokens.ts:5,23,135 (gap #3 claim).
- Parameterized queries / per-user tenancy (declaration item 6): Prisma throughout;
  packages/api/src/db-tenant.ts:1-43 (RLS tenant context, withTenant :41, anti-splice comment :33).
- ActionReceipt/sha256 floor (declaration item 6): packages/api/src/judge/attention-floor.ts:77-83,109;
  packages/api/src/agentcore/auto-reply-send.ts:16-40.
- Webhook auth (item 6): packages/api/src/routes/gmail-push.ts:73; packages/api/src/index.ts:208.
- Cost cap (item 6): packages/api/src/config.ts:152 (DAILY_COST_CAP_CENTS).
- Deletion/purge (item 7, gap #5): packages/api/src/user-deletion.ts:5-14,
  packages/api/src/purge-user-data.ts, packages/api/src/routes/auth.ts:1295.
- Log retention exists (gap #4): packages/api/src/log-retention.ts.
- Reversible trash (declaration item 1): packages/api/src/mail/gmail.ts:1266,1351.
-->
