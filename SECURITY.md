# Security

Klorn is an attention firewall that reads other people's email so you don't
have to. That sentence *is* the threat model: the product's primary input is
text written by untrusted third parties, some of whom are adversarial. This
document explains what Klorn considers in scope, what the architecture
guarantees, and how to report a vulnerability.

## Trust model: email is hostile input

Every inbound email is treated as attacker-controlled data. That includes the
possibility that a message is written *to manipulate the LLM that reads it* —
**prompt injection is explicitly in scope**, not an accepted limitation.

Concretely:

- All external content (email bodies, subjects, third-party text) is wrapped
  in `<untrusted_content>` markers before it ever reaches a model, and any
  pre-existing wrapper tags inside the raw content are stripped first so a
  crafted email cannot close the wrapper and smuggle instructions into the
  trusted context ([`packages/api/src/untrusted.ts`](packages/api/src/untrusted.ts)).
- More importantly, Klorn does **not** rely on prompt hygiene as its safety
  boundary. The boundary is structural — see the deterministic floor below. A
  fully successful injection against the classifier can misclassify a
  message; it cannot make Klorn send, forward, or destroy anything.

## The deterministic floor

The three real-world actions that cannot be undone with one click —
`send_email`, `delete_permanent`, `forward_external` — are **not available to
the LLM as a decision it can make**. They are gated by code, not by model
judgment ([`packages/api/src/judge/attention-floor.ts`](packages/api/src/judge/attention-floor.ts)):

- Every floor action requires an **`ActionReceipt`** minted at approval time.
  The receipt binds a sha256 **payload hash over the exact canonical bytes**
  being approved (recipient, subject, body — NFC-normalized; see
  `sendEmailPayloadHash`), not the natural-language description shown in the
  UI.
- At execute time a central guard in
  [`packages/api/src/agentcore/tool-executor.ts`](packages/api/src/agentcore/tool-executor.ts)
  **fails closed**: any floor action arriving without a receipt is refused
  (`FloorReceiptRequiredError`), and `verifyReceipt` re-hashes the
  about-to-execute payload — any drift between what was approved and what
  would run throws and aborts.
- Even the *autonomous* path obeys the floor. A user-configured auto-reply
  rule does not call Gmail directly; it mints a receipt over the exact bytes
  and routes through the same guard
  ([`packages/api/src/agentcore/auto-reply-send.ts`](packages/api/src/agentcore/auto-reply-send.ts)),
  which also rejects multi-recipient smuggling via a strict single-address
  check on the recipient.
- Deletion in normal operation is Gmail **trash (reversible)**, never
  permanent deletion.

So the worst case for a prompt-injected model is a wrong *classification* —
which the user sees and corrects, and which feeds the ground-truth ledger.
The worst case is never an outbound email or destroyed data.

## How this differs from general assistant frameworks

Most general-purpose "AI assistant" and agent frameworks treat prompt
injection as out of scope: they give the model a broad tool belt (send,
delete, browse, pay) and place the safety burden on the prompt, the user, or
a human-in-the-loop convention that the model itself mediates. That is a
reasonable trade-off for a general assistant — it is not acceptable for
software whose *job* is ingesting adversarial text all day.

Klorn's difference is structural, not rhetorical:

- The LLM's output surface is deliberately tiny: it scores four features
  (0–1) per email, and a deterministic, unit-tested rule maps them to a tier
  ([`packages/api/src/judge/tier-policy.ts`](packages/api/src/judge/tier-policy.ts)). The
  model perceives; readable code decides.
- Irreversible actions are separated from the model by the receipt gate
  above — approval is enforced by hash verification in code the model cannot
  reach, not by a system-prompt instruction the model could be talked out of.

## Claims and their falsifiers

The sections above state what Klorn guarantees. This section states, for each
guarantee, **what would disprove it and where that check lives** — so the
claims can be attacked without taking this document's word for anything.

A note on authority, because it matters more than the claims themselves: a
source that can only *agree* with a claim is not evidence for it. Each row
below names something that can make the claim fail.

| # | Claim | What would falsify it | Where the falsifier lives |
|---|---|---|---|
| C1 | The model never assigns a tier; a deterministic rule does. | Any code path that produces a tier without passing four clamped scalars through `tierFromFeatures`. | [`tier-policy.ts:96`](packages/api/src/judge/tier-policy.ts) · [`__tests__/tier-policy.test.ts`](packages/api/src/__tests__/tier-policy.test.ts) |
| C2 | Uncertainty degrades to visibility, never to silence. | A feature vector with `confidence < lowConfidenceFloor` (0.5) resolving to anything other than QUEUE. | [`tier-policy.ts:113`](packages/api/src/judge/tier-policy.ts) |
| C3 | AUTO is a classification, not an execution grant. | An AUTO tier causing a side effect while `AUTO_TIER_EXECUTION` is off. | `isActionableTier` in [`email-action-trigger.ts`](packages/api/src/agentcore/email-action-trigger.ts) |
| C4 | No floor action executes without a receipt. | Any `send_email` / `delete_permanent` / `forward_external` reaching execution with a null or absent `ActionReceipt`. | [`tool-executor.ts`](packages/api/src/agentcore/tool-executor.ts) · [`__tests__/tool-executor-floor.test.ts`](packages/api/src/__tests__/tool-executor-floor.test.ts) |
| C5 | Approval binds bytes, not intent. | Any payload mutation between mint and execute that `verifyReceipt` tolerates — including cross-action receipt reuse or a stale schema version. | [`attention-floor.ts:200`](packages/api/src/judge/attention-floor.ts) · [`__tests__/attention-floor.test.ts`](packages/api/src/__tests__/attention-floor.test.ts) |
| C6 | A floor violation is terminal, not retried. | A receipt mismatch that re-enters the retry queue instead of failing permanently. | [`action-outbox.ts:106`](packages/api/src/agentcore/action-outbox.ts) |
| C7 | Retries never re-consult the model. | A retry path that re-derives tool arguments from an LLM instead of replaying the persisted `toolArgs` + receipt. | [`action-outbox.ts`](packages/api/src/agentcore/action-outbox.ts) |
| C8 | The product still works with no LLM at all. | The deterministic keyword path failing to produce a tier, or the measured no-LLM floor dropping below what is published. | [`keyword-policy.ts`](packages/api/src/judge/keyword-policy.ts) · [`__tests__/eval-floors.test.ts`](packages/api/src/__tests__/eval-floors.test.ts) |
| C9 | The policy the classifier runs on is inspectable. | `describePolicy()` diverging from the constants actually used, or a caller mutating the snapshot and affecting live classification. | [`ontology.ts:41`](packages/api/src/learning/ontology.ts) |

### What does **not** have authority here

- **The eval sets** ([`packages/api/eval/`](packages/api/eval)) measure
  *classification accuracy*. They say nothing about whether authority is
  contained. A 94% accuracy number is not a safety argument and is not
  offered as one. Accuracy and containment are different properties with
  different falsifiers, and conflating them is the most common way a claim
  like C4 gets "supported" by evidence that cannot test it.
- **This document.** It describes intent. Only the code and the tests it
  cites can refuse anything.
- **The absence of a reported incident.** Not evidence.

### Known gaps, stated rather than omitted

- **No end-to-end adversarial corpus yet.** C4 and C5 are covered by unit
  tests that start at the tool call. What does not exist yet is a fixture set
  that starts at a *hostile email* — one written to maximize model confidence
  and to argue for an irreversible action — and asserts containment across
  the whole path from ingestion to execution. The tier may legitimately come
  out wrong in such a case; the assertion is that no floor action becomes
  reachable. Contributions welcome: open an issue or a PR against
  `packages/api/src/__tests__/`.
- **No dedicated in-app second factor for the admin surface.** Administrative
  routes enforce a server-side role check plus full session validation, and
  the sole administrator's only authentication path is Google OAuth protected
  by Google 2-Step Verification — but Klorn itself does not mint a second
  factor.
- **`AUTO_TIER_EXECUTION` changes the shape of C3 when enabled.** It is off by
  default; every claim above is stated for the default configuration.

## Data protection

- **Encryption at rest**: Google OAuth tokens are encrypted with
  **AES-256-GCM** before touching the database, with keyring-based key
  rotation (v1/v2 envelopes) so a suspected key leak can be rotated without a
  flag day ([`packages/api/src/crypto-tokens.ts`](packages/api/src/crypto-tokens.ts)).
  Missing keys outside dev/test abort boot — the server never silently falls
  back to a weaker mode.
- **Encryption in transit**: all hosted surfaces (API, web, Google APIs,
  LLM providers) are TLS-only. Self-hosters should front the compose stack
  with a TLS reverse proxy (see [`docs/self-hosting.md`](docs/self-hosting.md)).
- **Per-user scoping**: every mail row, classification, receipt, and token is
  keyed to the owning user; receipts additionally record `approvedBy` as
  defense-in-depth. Insecure dev conveniences (dev JWT secret, dev
  encryption key, localhost CORS, demo user) are gated behind an explicit
  dev/test allowlist that **fails closed** for any other `NODE_ENV` value
  ([`packages/api/src/env.ts`](packages/api/src/env.ts)).
- **First-party analytics only**: retention instrumentation is a short
  allowlist of coarse event names stored in Klorn's own Postgres — no
  external tracker, and never message content
  ([`packages/api/src/analytics.ts`](packages/api/src/analytics.ts)).

## Why always-on background operation is safe

Klorn runs continuously on desktop and mobile — syncing, classifying, and
occasionally interrupting you — without a human watching it. That is safe by
construction, not by good behavior:

- **Autonomy is confined to reading and classifying.** The background loop
  reads mail, scores it, applies reversible mailbox state (labels,
  read-state, archive), and decides whether to notify. The agent defaults to
  SUGGEST mode: read-only tools plus propose-only output.
- **Every real-world action still crosses the approval gate.** Anything that
  leaves your mailbox — a send, a forward, a permanent delete — requires an
  `ActionReceipt` whose payload hash was fixed at approval time, regardless
  of whether the request originated from the UI, the chat surface, or the
  autonomous loop. There is no privileged background path around the floor.
- **Even opted-in automation is bounded.** An AUTO_REPLY rule you configured
  is itself the authorization, but its LLM-authored body still passes
  through receipt minting and hash verification, and rate/cost caps bound
  background LLM activity ([`packages/api/src/config.ts`](packages/api/src/config.ts)).

This is the founding design bet: an assistant you can leave alone must be one
whose autonomous half is *incapable* of irreversible action — not one that
promises to ask first.

## Reporting a vulnerability

- Email **k0820086@gmail.com** with a description and reproduction steps.
  Please do not open a public issue for exploitable findings.
- You can also use GitHub's private vulnerability reporting on
  [k08200/klorn](https://github.com/k08200/klorn) if enabled.
- You'll get an acknowledgment within a few days; fixes for the deterministic
  floor and token-encryption paths take priority over everything else.

## Audit history

- **2026-07-20** — three-agent internal security audit (separate
  security/consistency/quality passes) across the API surface; findings
  driving the CASA-hardening changes visible in the codebase (e.g.
  fail-closed CORS, dev-fallback allowlisting, floor-bypass closure for
  autonomous replies).
