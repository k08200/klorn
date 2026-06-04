# Deterministic floor

**Status:** Active doctrine. Adopted 2026-06-04 in response to the dev.to
thread on the firewall classifier (PR #468 follow-up).

**One-line:** Classifier confidence + the input-hash from PR #468 is
sufficient for every reversible action. For actions whose effect cannot
be undone with a single user click, we additionally sign the **output
artifact** — the bytes that will actually travel to Gmail — and refuse
to execute if those bytes diverge from what the user approved.

## The line

> Any action that cannot be undone with a single user click.

The test is *client-side undo capability*, not "irreversible" in the
abstract. If the user can undo it from their inbox in one motion,
classifier confidence is enough. If they can't, we need a floor.

## The list (Klorn email domain)

| Action | Why on the floor |
|---|---|
| `send_email` | Gmail "Undo send" is 30 seconds. After that, irreversible. |
| `delete_permanent` | Hard delete skipping Trash — no recovery path. |
| `forward_external` | Same network effect as send to an outside party. |

### NOT on the floor (ride on classifier + #468 hash)

- Archive (un-archive is one click)
- Move to Trash (recover from Trash is one click)
- Apply / remove label
- Mark read / unread
- Tier override (`SILENT` ↔ `QUEUE` ↔ `PUSH` — just re-classify)
- Snooze

These are reversible client-side. Adding a deterministic floor to them
would be over-engineering.

## Why this shape

The dev.to commenter named the threat in the crypto domain as
**agent-vs-ABI mismatch**: the agent narrates a high-level intent
("swap 1 ETH for USDC on Uniswap") and the ABI decode of the calldata
shows a different router, wrong slippage, or approval to the wrong
contract. The agent isn't lying — natural language is lossy by
definition. The cure isn't to verify the narration, it's to **stop
signing on the narration** and sign on the deterministic artifact
(the calldata) instead.

For Klorn's email domain the deterministic artifact is `payloadHash`:

- `send_email`: `sha256(canonical({ to, subject, body }))`
- `delete_permanent`: `sha256(canonical({ gmailId }))`
- `forward_external`: `sha256(canonical({ gmailId, to }))`

Canonical = NFC normalize text, trim+lowercase email addresses, prefix
with schema version, JSON.stringify with sorted keys.

The `ActionReceipt` minted at `/approve` time pins this hash. At execute
time, the tool recomputes the hash from the about-to-execute payload
and calls `verifyReceipt`. Any mismatch throws and the action is refused.

## How to add a new floor action

If you find yourself adding a tool whose effect cannot be undone with
one click, you have three things to do:

1. Justify in the PR description **why client-side undo is impossible**.
   ("Gmail API has no reversal endpoint for this operation" is the
   shape of an acceptable answer; "it would be annoying to undo" is not.)
2. Add a matching `*PayloadHash` function in
   [`packages/api/src/attention-floor.ts`](../../packages/api/src/attention-floor.ts)
   whose canonical body covers every field the action will send to Gmail.
3. Wire the new action into `tool-executor.ts` to refuse execution
   without a verified `ActionReceipt`.

## What this doctrine does NOT cover

- **Plan-stale revocation.** The dev.to commenter raised this — when a
  multi-step plan goes partly stale, do you abort and rebuild or let
  the surviving prefix continue? Klorn doesn't ship multi-step action
  plans yet (single tool calls only, gated by `/approve`), so the
  question is moot today. When we ship multi-step plans, the
  architectural commit will be preceded by instrumenting both
  strategies and measuring — not picking by intuition.
- **Receipt storage and audit trail.** The mint/verify helpers live in
  `attention-floor.ts`. Storing receipts in `PendingAction.toolArgs`
  and exposing an audit endpoint is a follow-up PR.
- **Schema version migration.** Bumping `RECEIPT_SCHEMA_VERSION`
  invalidates every pending receipt and forces a re-approve. That's
  the intended behaviour, not a bug; deliberate enough that it deserves
  a CHANGELOG entry when it happens.

## Related code

- [`packages/api/src/attention-floor.ts`](../../packages/api/src/attention-floor.ts) — types, payload hashes, mint, verify.
- [`packages/api/src/attention-input-hash.ts`](../../packages/api/src/attention-input-hash.ts) — input-hash binding from PR #468 (the input side of this same property).
- [`packages/api/src/__tests__/attention-floor.test.ts`](../../packages/api/src/__tests__/attention-floor.test.ts) — stability + sensitivity + cross-action refusal tests.
