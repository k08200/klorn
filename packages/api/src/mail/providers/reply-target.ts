/**
 * How a caller names the message it is answering (step B0b of
 * docs/providers/unified-platform-plan.md).
 *
 * A provider that threads by the original's id declares `nativeReply`. For any
 * other provider this adds nothing, so the options and draft input a Gmail or IMAP
 * provider receives stay exactly what they were before B0b.
 *
 * `providerMessageId` must come from a row the server resolved (the `gmailId` of the
 * caller's own `EmailMessage`), never from input a caller or an agent supplied.
 */

import type { MailProviderActions, ReplyTarget } from "./types.js";

export function replyTargetFor(
  actions: Pick<MailProviderActions, "nativeReply">,
  providerMessageId: string,
): ReplyTarget {
  return actions.nativeReply === true ? { replyToProviderMessageId: providerMessageId } : {};
}
