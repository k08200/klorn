/**
 * Deterministic-floor enforcement on the caller side. When the tool being
 * invoked is in FLOOR_ACTIONS, the caller MUST provide a verified
 * ActionReceipt — otherwise executeToolCall throws FloorReceiptRequiredError
 * and the action is refused before any side-effect.
 *
 * The receipt is minted at /approve time (chat-pending-actions.ts) so
 * direct executeToolCall callers (autonomous-agent, batch-executor) that
 * try to side-step the user approval flow now fail closed instead of
 * silently sending mail / forwarding / hard-deleting.
 */
export class FloorReceiptRequiredError extends Error {
  constructor(public readonly toolName: string) {
    super(`floor action "${toolName}" requires a verified ActionReceipt — none provided`);
    this.name = "FloorReceiptRequiredError";
  }
}
