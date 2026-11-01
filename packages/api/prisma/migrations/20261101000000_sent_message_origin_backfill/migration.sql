-- Legacy SentMessage provenance (2026-11-01). #1591 added "origin" with no
-- backfill, so every row recorded before it is NULL, and NULL reads as "the
-- user wrote it" to the attention engine v3 relationship snapshot
-- (docs/design/attention-engine-v3.md §3(2)). Mail Klorn sent on its own
-- (unattended replies) and mailto unsubscribe requests would count as the
-- user writing to that address, and an unsubscribe would sit in "waiting on".
--
-- This labels only rows with proof, from records written at the time of the
-- send. Everything else stays NULL: no proof that Klorn sent it. 'user' is
-- never written: no legacy row carries proof of a manual send (the manual
-- routes recorded at send time, and production has no row whose createdAt is
-- within seconds of its sentAt), and NULL already counts as the user's.
--
--   approved     the gmailId equals the messageId an executed approval
--                returned (ActionOutbox COMPLETED, or PendingAction EXECUTED
--                from before the outbox).
--   auto_reply   an unattended-reply claim (Notification dedupeKey
--                auto-reply:<gmailId> / auto-mode-reply:<gmailId>, or the
--                pre-dedupeKey "Auto-reply sent" row) for the mail answered,
--                with the claim's recipient, the exact "Re: <subject>" both
--                senders use (auto-mode-sweep.ts, deliverRuleAutoReply), and a
--                send within [claim - 1 min, claim + 2 min]: both write the
--                claim after drafting and send right after it. Only the first
--                such row per claim counts, so a manual reply right after stays
--                the user's. A claim rewritten as failed means nothing left,
--                so it never counts. Claims are at-most-once locks that
--                clearing notifications never deletes.
--   unsubscribe  the row's single recipient IS a mailto List-Unsubscribe
--                target of a mail the user received in the same account
--                before the send. The subject is derived like
--                parseMailtoTarget (list-unsubscribe.ts): '+' is a space,
--                ASCII %XX escapes are decoded, then trimmed, default
--                'unsubscribe'. Either the subject equals it exactly, or the
--                target subject carries a per-mail token (16+ letters/digits),
--                the row's subject has the same shape (same length, same
--                non-alphanumeric characters in the same places), and that
--                address never sends the user mail. A subject like "Question
--                about order 123" to a real mailbox a newsletter names never
--                qualifies.
--
-- Dry run against production on 2026-11-01 (the UPDATEs inside a DO block that
-- raises, so rolled back): approved 0, auto_reply 4, unsubscribe 37, of 192
-- NULL rows. 28 unsubscribes match the decoded subject exactly; 9 are token
-- subjects whose own carrier mail is no longer stored (same shape, 44-60
-- token characters, endpoints that never mail the user). Known unprovable:
-- 1 row sent before the send floor deployed (2026-06-04 10:22 UTC), when the
-- autonomous agent could send without a receipt; no log of that era survives.
--
-- Scope: every NULL row with proof, legacy or scanned since (production had
-- none of the latter on 2026-11-01). A sent-history import applies the same
-- rules to the rows it creates, so the two cannot disagree.
--
-- Deploy check: scripts/start.sh baselines a migration that keeps failing when
-- the schema diff is empty, and this one changes no schema. After deploy,
-- confirm SELECT origin, count(*) FROM "SentMessage" GROUP BY 1 shows the
-- labels; if all are NULL, run this file by hand (it is idempotent).
--
-- Every statement fills NULLs only: a label recorded at send time is never
-- overwritten and a re-run is a no-op. To undo one label, run the same
-- predicate with SET "origin" = NULL WHERE "origin" = '<label>'.

SET LOCAL lock_timeout = '5s';

UPDATE "SentMessage" s SET "origin" = 'approved'
WHERE s."origin" IS NULL AND (
  EXISTS (
    SELECT 1 FROM "ActionOutbox" o
    WHERE o."userId" = s."userId"
      AND o."toolName" = 'send_email' AND o."status" = 'COMPLETED'
      AND substring(o."result" from '"messageId":"([^"]+)"') = s."gmailId"
  )
  OR EXISTS (
    SELECT 1 FROM "PendingAction" p
    WHERE p."userId" = s."userId"
      AND p."toolName" = 'send_email' AND p."status" = 'EXECUTED'
      AND substring(p."result" from '"messageId":"([^"]+)"') = s."gmailId"
  )
);

UPDATE "SentMessage" s SET "origin" = 'auto_reply'
WHERE s."origin" IS NULL AND EXISTS (
  SELECT 1 FROM "Notification" n
  JOIN "EmailMessage" e
    ON e."userId" = n."userId"
   AND e."gmailId" = COALESCE(substring(n."dedupeKey" from '^(?:auto-reply|auto-mode-reply):(.+)$'), substring(n."message" from '\[([^\]]+)\]\s*$'))
  WHERE n."userId" = s."userId"
    AND (n."dedupeKey" LIKE 'auto-reply:%' OR n."dedupeKey" LIKE 'auto-mode-reply:%' OR (n."dedupeKey" IS NULL AND n."title" = 'Auto-reply sent'))
    AND n."title" NOT IN ('Auto-reply failed', 'Auto-mode reply failed')
    AND lower(btrim(s."to")) = lower(substring(n."message" from '(?:replied|reply) to (\S+)'))
    AND s."subject" = 'Re: ' || e."subject"
    AND s."sentAt" BETWEEN n."createdAt" - interval '1 minute' AND n."createdAt" + interval '2 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM "SentMessage" earlier
      WHERE earlier."userId" = s."userId"
        AND lower(btrim(earlier."to")) = lower(btrim(s."to")) AND earlier."subject" = s."subject"
        AND earlier."sentAt" BETWEEN n."createdAt" - interval '1 minute' AND n."createdAt" + interval '2 minutes'
        AND (earlier."sentAt" < s."sentAt" OR (earlier."sentAt" = s."sentAt" AND earlier."id" < s."id"))
    )
);

WITH targets AS MATERIALIZED (
  SELECT DISTINCT
    m."userId",
    COALESCE(m."linkedInboxAccountId", 'primary') AS inbox,
    m."receivedAt",
    lower(btrim(split_part(regexp_replace(m."listUnsubscribeMailto", '^mailto:', '', 'i'), '?', 1))) AS addr,
    COALESCE(NULLIF(regexp_replace(d.subject, '^\s+|\s+$', '', 'g'), ''), 'unsubscribe') AS subject
  FROM "EmailMessage" m
  CROSS JOIN LATERAL (
    SELECT string_agg(
      CASE WHEN x.part[1] ~ '^%[0-7][0-9A-Fa-f]$' AND x.part[1] <> '%00'
        THEN chr(('x' || substr(x.part[1], 2))::bit(8)::int)
        ELSE x.part[1] END,
      '' ORDER BY x.ord) AS subject
    FROM regexp_matches(replace(substring(m."listUnsubscribeMailto" from '[?&]subject=([^&#]*)'), '+', ' '), '%[0-9A-Fa-f]{2}|[^%]+|%', 'g') WITH ORDINALITY AS x(part, ord)
  ) d
  WHERE m."listUnsubscribeMailto" IS NOT NULL
)
UPDATE "SentMessage" s SET "origin" = 'unsubscribe'
WHERE s."origin" IS NULL AND EXISTS (
  SELECT 1 FROM targets t
  WHERE t."userId" = s."userId"
    AND t.addr <> '' AND t.addr = lower(btrim(s."to"))
    AND t.inbox = s."inbox" AND s."sentAt" >= t."receivedAt"
    AND (
      t.subject = s."subject"
      OR (
        length(regexp_replace(t.subject, '[^A-Za-z0-9]', '', 'g')) >= 16
        AND regexp_replace(s."subject", '[A-Za-z0-9]', 'x', 'g') = regexp_replace(t.subject, '[A-Za-z0-9]', 'x', 'g')
        AND NOT EXISTS (
          SELECT 1 FROM "EmailMessage" e
          WHERE e."userId" = s."userId"
            AND (e."fromAddress" = t.addr OR position(t.addr in lower(e."from")) > 0)
        )
      )
    )
);
