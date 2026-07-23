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

- Email **hello@klorn.ai** with a description and reproduction steps.
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
