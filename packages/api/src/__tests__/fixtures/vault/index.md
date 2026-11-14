---
klorn_type: "index"
klorn_vault_version: 1
exported_at: "2026-11-14T09:00:00+09:00"
time_zone: "Asia/Seoul"
mails: 3
includes_mail_text: false
complete: true
tags:
  - "klorn"
---
# Klorn vault

Your Klorn data as markdown, exported 2026-11-14T09:00:00+09:00 (Asia/Seoul). This is a snapshot: Klorn keeps the original, and editing these notes changes nothing in Klorn. Export again for a fresh copy.

## Lanes

Klorn puts every mail in one of five lanes. A lane is how Klorn classified the mail; it never acts on the mail.

| Lane | Meaning | Mails |
| --- | --- | --- |
| [[Klorn/lanes/PUSH\|PUSH]] | Needs you now: Klorn notifies you. | 2 |
| [[Klorn/lanes/MEETING\|MEETING]] | Scheduling mail: notifies like PUSH, with a calendar check. | 0 |
| [[Klorn/lanes/QUEUE\|QUEUE]] | Worth reading today, without a notification. The default lane. | 0 |
| [[Klorn/lanes/INFO\|INFO]] | Receipts, confirmations and status notices: filed, no reply expected. | 1 |
| [[Klorn/lanes/SILENT\|SILENT]] | Recorded and kept out of your way. | 0 |

## Reading a mail note

One note per mail, in `Klorn/mail/YYYY/MM/`. `klorn_id` stays the same across exports. Its properties:

- `lane`: the lane Klorn put the mail in.
- `lane_reason`: why. With `lane_reason_verified: true` it is a quote checked word for word against the mail; otherwise it is Klorn's own summary, not checked.
- `judged_by`: what decided the lane. `llm`, `fast-path`, `sender-prior` and `keyword-fallback` are Klorn's classifier paths; `you` means you moved it; `agent` means an agent you connected moved it; `klorn` means no path was recorded.
- `policy`: the attention policy version, when one decided.
- `status`: `open`, `resolved`, `dismissed` or `snoozed`.
- `lane_feedback`: `override` when you moved the mail to another lane, `confirm` when you confirmed its lane.
- `you` and `you_at`: the strongest thing you did with the mail that Klorn recorded: `replied`, `archived`, `unsubscribed`, `dismissed`, `snoozed`, `starred` or `opened`.

Full mail text is not included: a mail note holds the subject, the preview line and Klorn's decision, with any quote Klorn checked against the mail. Export again with mail text turned on to add the full text.

## Also here

- [[Klorn/commitments/active|Active commitments]] (2) and [[Klorn/commitments/done|done or dismissed]] (2).
- `Klorn/senders/`: one note per sender (1), by organisation domain or, for public mail providers, by address, with lane counts and what Klorn learned about them.
