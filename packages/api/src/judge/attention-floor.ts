/**
 * Deterministic floor — the bytes-level layer underneath the classifier.
 *
 * From the dev.to thread on the firewall classifier (PR #468 follow-up):
 *
 *   > Every irreversible action deserves its own deterministic source. The
 *   > probabilistic layer can stay probabilistic if the deterministic floor
 *   > catches the cases where probability isn't enough. We've ended up
 *   > drawing the line at "anything that can't be undone client-side."
 *
 * Klorn's email-domain interpretation: classifier confidence + the input
 * hash from `attention-input-hash.ts` (PR #468) is sufficient for every
 * reversible action (archive, trash, label, mark-read, tier override,
 * snooze). For the small set of actions whose effect cannot be undone with
 * a single user click, we additionally sign the **output artifact** — the
 * bytes that will actually travel to Gmail. That signed object is the
 * `ActionReceipt` minted here at /approve time and verified at execute time.
 *
 * The dev.to commenter named the threat as **agent-vs-ABI mismatch** in the
 * crypto domain — the agent narrates a high-level intent ("swap 1 ETH on
 * Uniswap") and the ABI decode shows the calldata does something the
 * narration glossed over (wrong router, wrong slippage, approval to a
 * different contract). The agent isn't lying; natural language is lossy
 * by definition. The cure isn't to verify the narration, it's to **stop
 * signing on the narration** and sign on the deterministic artifact instead.
 *
 * For email, the deterministic artifact is the `payloadHash` — a sha256
 * over the canonical (recipient, subject, body) tuple for `send_email`,
 * over (gmailId) for `delete_permanent`, and over (recipient, gmailId)
 * for `forward_external`. If the bytes about to be sent diverge from the
 * bytes the user approved, the receipt verification throws and the action
 * is refused. This is the floor.
 *
 * Things this module does NOT do (kept narrow on purpose):
 *
 *   - It does not store receipts. PendingAction.toolArgs is the durable
 *     home (separate PR will wire that in). This module only mints, hashes,
 *     and verifies.
 *   - It does not enforce the floor at tool-invocation time. Wiring into
 *     `tool-executor.ts` for the three FLOOR_ACTIONS is the next PR.
 *   - It does not address multi-step plan invalidation. Klorn doesn't ship
 *     multi-step action plans yet — when we do, the rebuild-vs-survive
 *     strategy gets instrumented and measured before architectural commit.
 *
 * See `project_klorn_deterministic_floor.md` for the doctrine and
 * `docs/doctrine/deterministic-floor.md` for the version on disk.
 */

import crypto from "node:crypto";

/**
 * The actions that cannot be undone with a single user click. Everything
 * else rides on classifier confidence + the input-hash from PR #468.
 *
 * Adding to this list is a deliberate doctrine change — it should always
 * come with: (1) a justification of why client-side undo is impossible,
 * (2) the matching payload-hash function below, (3) the tool-executor
 * wiring that refuses to execute without a verified ActionReceipt.
 */
export const FLOOR_ACTIONS = ["send_email", "delete_permanent", "forward_external"] as const;
export type FloorAction = (typeof FLOOR_ACTIONS)[number];

export function isFloorAction(name: string): name is FloorAction {
  return (FLOOR_ACTIONS as readonly string[]).includes(name);
}

/**
 * The signed artifact. The user clicked "approve" on the bytes encoded
 * here, not on the natural-language description shown in the UI. Any
 * mutation to the about-to-execute payload between mint and execute
 * causes verifyReceipt to throw.
 *
 * Schema version is part of the receipt so a future bump deliberately
 * invalidates every pending receipt and forces a re-approve under the
 * new shape — the same pattern as HASH_SCHEMA_VERSION in #468.
 */
export interface ActionReceipt {
  v: "v1";
  action: FloorAction;
  /** Hash from PR #468 — the input bytes that drove the classifier into AUTO/PUSH. */
  inputHash: string;
  /** Hash of the action-specific output payload (see *PayloadHash functions). */
  payloadHash: string;
  /** Identity of the affected target — "to" address, gmailId, etc. Used by audit, not by verify. */
  target: string;
  /** ISO timestamp when the user approved. */
  approvedAt: string;
  /** User who approved — defense-in-depth, receipts are user-keyed. */
  approvedBy: string;
}

export const RECEIPT_SCHEMA_VERSION = "v1" as const;

/**
 * Canonical, normalized hash of the bytes a `send_email` will actually
 * deliver to Gmail. Trim and lowercase the recipient so cosmetic edits
 * ("Alice@Example.com " ↔ "alice@example.com") don't false-positive the
 * verification at execute time. Body and subject get NFC normalization
 * so composed/decomposed Unicode (Korean, in particular) hashes the same.
 */
export function sendEmailPayloadHash(input: { to: string; subject: string; body: string }): string {
  const canonical = {
    v: RECEIPT_SCHEMA_VERSION,
    action: "send_email" as const,
    to: input.to.normalize("NFC").trim().toLowerCase(),
    subject: input.subject.normalize("NFC"),
    body: input.body.normalize("NFC"),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Canonical hash for `delete_permanent` (skip-Trash delete). Targets a
 * specific gmailId; mutating that id between approve and execute is the
 * exact failure mode we're guarding against.
 */
export function deletePermanentPayloadHash(input: { gmailId: string }): string {
  const canonical = {
    v: RECEIPT_SCHEMA_VERSION,
    action: "delete_permanent" as const,
    gmailId: input.gmailId,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Canonical hash for `forward_external` — same kind of network effect as
 * send, so same kind of floor. Forwarding the wrong message OR forwarding
 * to the wrong external party would both flip the hash.
 */
export function forwardExternalPayloadHash(input: { gmailId: string; to: string }): string {
  const canonical = {
    v: RECEIPT_SCHEMA_VERSION,
    action: "forward_external" as const,
    gmailId: input.gmailId,
    to: input.to.normalize("NFC").trim().toLowerCase(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Construct an ActionReceipt from a pre-computed payload hash. Callers
 * should compute the payload hash with the matching *PayloadHash function
 * above so the receipt is byte-equal to what verifyReceipt will recompute
 * at execute time.
 */
export function mintReceipt(input: {
  action: FloorAction;
  inputHash: string;
  payloadHash: string;
  target: string;
  approvedAt: Date;
  approvedBy: string;
}): ActionReceipt {
  return {
    v: RECEIPT_SCHEMA_VERSION,
    action: input.action,
    inputHash: input.inputHash,
    payloadHash: input.payloadHash,
    target: input.target,
    approvedAt: input.approvedAt.toISOString(),
    approvedBy: input.approvedBy,
  };
}

export class ActionReceiptMismatchError extends Error {
  constructor(
    public readonly receipt: ActionReceipt,
    public readonly currentPayloadHash: string,
  ) {
    super(
      `floor violated: ${receipt.action} payload mutated between approve and execute ` +
        `(approved=${receipt.payloadHash.slice(0, 12)}… current=${currentPayloadHash.slice(
          0,
          12,
        )}…)`,
    );
    this.name = "ActionReceiptMismatchError";
  }
}

export class ActionReceiptSchemaError extends Error {
  constructor(public readonly receipt: ActionReceipt) {
    super(
      `floor violated: receipt schema "${receipt.v}" does not match current ` +
        `"${RECEIPT_SCHEMA_VERSION}" — re-approve required`,
    );
    this.name = "ActionReceiptSchemaError";
  }
}

/**
 * Verify a receipt against the bytes currently about to be executed. Throws
 * loud on any mismatch — schema version, action class, or payload hash.
 *
 * Callers do NOT pre-recompute the payload hash; pass the about-to-execute
 * payload object and let the matching *PayloadHash function run, so the
 * verify path is the canonical bytes path.
 */
export function verifyReceipt(
  receipt: ActionReceipt,
  expected: { action: FloorAction; currentPayloadHash: string },
): void {
  if (receipt.v !== RECEIPT_SCHEMA_VERSION) throw new ActionReceiptSchemaError(receipt);
  if (receipt.action !== expected.action) {
    // Reusing a send_email receipt to authorize a delete_permanent is the
    // exact kind of cross-action mistake the receipt is meant to refuse.
    throw new ActionReceiptMismatchError(receipt, expected.currentPayloadHash);
  }
  if (receipt.payloadHash !== expected.currentPayloadHash) {
    throw new ActionReceiptMismatchError(receipt, expected.currentPayloadHash);
  }
}
