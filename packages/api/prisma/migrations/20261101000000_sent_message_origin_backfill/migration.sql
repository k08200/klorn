-- Legacy SentMessage provenance (2026-11-01). #1591 added "origin" with no
-- backfill, so every row recorded before it is NULL, and NULL reads as "the
-- user wrote it" to the attention engine v3 relationship snapshot
-- (docs/design/attention-engine-v3.md §3(2)). Mail Klorn sent on its own
-- (unattended replies, mailto unsubscribes) would count as the user writing
-- to that address.
--
-- This labels ONLY the legacy rows Klorn can prove it sent, from records
-- written at the time of the send. Everything else stays NULL, which keeps
-- its meaning: seen by the Sent-folder scan with no trace of Klorn = the
-- user's own mail. 'user' is never written: no legacy row carries proof of a
-- manual send (the manual routes recorded at send time, and production has
-- no row whose createdAt is within seconds of its sentAt), and NULL already
-- counts as the user's.
--
--   approved     the gmailId equals the messageId an executed approval
--                returned (ActionOutbox COMPLETED, or PendingAction EXECUTED
--                from before the outbox).
--   auto_reply   an unattended-reply claim (Notification dedupeKey
--                auto-reply:<gmailId> / auto-mode-reply:<gmailId>, or the
--                pre-dedupeKey "Auto-reply sent" row) for the mail answered,
--                with the claim's recipient, the exact "Re: <subject>" both
--                senders use (auto-mode-sweep.ts, deliverRuleAutoReply), and a
--                send within [claim - 1 min, claim + 10 min]. Claims are
--                at-most-once locks that clearing notifications never deletes.
--   unsubscribe  the row's single recipient IS a mailto List-Unsubscribe
--                target the user received, derived like parseMailtoTarget
--                (list-unsubscribe.ts). When that address also sends the user
--                mail (it could be a person), the subject must also equal the
--                mailto subject exactly. A percent-encoded subject never
--                matches here, so such a row stays NULL unless its address is
--                a dedicated unsubscribe endpoint.
--
-- Dry run against production on 2026-11-01 (same predicates as SELECTs):
-- approved 0, auto_reply 4, unsubscribe 37, overlaps 0, of 192 NULL rows.
-- Known unprovable: 1 row sent before the send floor deployed
-- (2026-06-04 10:22 UTC), when the autonomous agent could send without a
-- receipt; no log of that era survives, so it stays NULL.
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
    AND lower(btrim(s."to")) = lower(substring(n."message" from '(?:replied|reply) to (\S+)'))
    AND s."subject" = 'Re: ' || e."subject"
    AND s."sentAt" BETWEEN n."createdAt" - interval '1 minute' AND n."createdAt" + interval '10 minutes'
);

WITH targets AS (
  SELECT DISTINCT "userId",
    lower(btrim(split_part(regexp_replace("listUnsubscribeMailto", '^mailto:', '', 'i'), '?', 1))) AS addr,
    COALESCE(NULLIF(btrim(replace(substring("listUnsubscribeMailto" from '[?&]subject=([^&]*)'), '+', ' ')), ''), 'unsubscribe') AS subject
  FROM "EmailMessage"
  WHERE "listUnsubscribeMailto" IS NOT NULL
)
UPDATE "SentMessage" s SET "origin" = 'unsubscribe'
WHERE s."origin" IS NULL AND EXISTS (
  SELECT 1 FROM targets t
  WHERE t."userId" = s."userId"
    AND t.addr <> '' AND t.addr = lower(btrim(s."to"))
    AND (t.subject = s."subject" OR NOT EXISTS (
      SELECT 1 FROM "EmailMessage" e
      WHERE e."userId" = s."userId"
        AND (e."fromAddress" = t.addr OR position(t.addr in lower(e."from")) > 0)
    ))
);
