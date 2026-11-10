"use client";

/**
 * The Mail v2 header's Done (and its `e` key): after the archive succeeds,
 * record the reply-needed DISMISSED signal the old "Reply state" Done sent.
 * Archive is the user's intent, so this only runs after it and never surfaces
 * an error: a failed feedback call is reported to Sentry and nothing else.
 * The rules (when to send, no double-send) live in reader-done-feedback.ts.
 */

import { useCallback, useRef } from "react";
import { apiFetch } from "../../../../lib/api";
import { captureClientError } from "../../../../lib/sentry";
import { doneFeedbackRequest, type ReplyStateSeen } from "./reader-done-feedback";

export interface DoneFeedback {
  /** Pass to ReplyNeededFeedbackControl's onStateChange. */
  onReplyStateChange: (emailId: string, choice: string | null) => void;
  /** Call once the archive has succeeded. Fire-and-forget. */
  sendAfterDone: (email: { id: string; needsReply: boolean }) => void;
}

export function useDoneFeedback(): DoneFeedback {
  const replyState = useRef<ReplyStateSeen | null>(null);
  const sentFor = useRef<string | null>(null);

  const onReplyStateChange = useCallback((emailId: string, choice: string | null) => {
    replyState.current = choice === null ? null : { emailId, choice };
  }, []);

  const sendAfterDone = useCallback((email: { id: string; needsReply: boolean }) => {
    const request = doneFeedbackRequest({
      emailId: email.id,
      needsReply: email.needsReply,
      replyState: replyState.current,
      sentFor: sentFor.current,
    });
    if (!request) return;
    sentFor.current = email.id;
    apiFetch(request.path, { method: "POST", body: JSON.stringify(request.body) }).catch((err) =>
      captureClientError(err, { scope: "email.detail.done-feedback", emailId: email.id }),
    );
  }, []);

  return { onReplyStateChange, sendAfterDone };
}
