"use client";

// "Draft reply" → the draft, verbatim and editable → Send. The draft is model
// output written from untrusted mail: it is shown as plain text in a textarea
// (never rendered as markup) and nothing leaves until the user taps Send. Send
// carries the body on screen and the hash of the recipient, subject and body
// on screen; the server refuses anything else and keeps a receipt of what went.

import type { SmartReplyDraftWire, SmartReplySendResponse } from "@klorn/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { apiFetch } from "../../lib/api";
import { isEntitlementRefusal } from "../../lib/entitlement";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { ProFeatureNotice } from "../pro-feature-notice";
import Button from "../ui/button";
import { apiErrorStatus, replySendRequest, smartActionPath } from "./model";

const RECEIPT_PREFIX_CHARS = 12;

/** The i18n key for a failed Send, by what the server said happened. */
function sendErrorKey(err: unknown): string {
  switch (apiErrorStatus(err)) {
    case 412:
      return "smartActions.reply.changed";
    case 502:
      return "smartActions.reply.unknown";
    default:
      return "smartActions.reply.error";
  }
}

export function SmartReplyCard({ emailId }: { emailId: string }) {
  const { t } = useT();
  const bodyId = useId();
  const [edited, setEdited] = useState<string | null>(null);

  const draft = useQuery({
    queryKey: queryKeys.smartActions.replyDraft(emailId),
    queryFn: () =>
      apiFetch<SmartReplyDraftWire>(smartActionPath(emailId, "reply-draft"), { method: "POST" }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

  const send = useMutation({
    mutationFn: (request: ReturnType<typeof replySendRequest>) =>
      apiFetch<SmartReplySendResponse>(smartActionPath(emailId, "reply"), {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onError: (err) => {
      // 412: what was on screen is not what would go out. Nothing was sent;
      // reload the recipient and subject so the user reviews what would.
      if (apiErrorStatus(err) === 412) {
        void draft.refetch();
        return;
      }
      if (!isEntitlementRefusal(err)) captureClientError(err);
    },
  });

  const shown = draft.data;
  if (!shown) {
    if (draft.isError) {
      if (isEntitlementRefusal(draft.error)) return <ProFeatureNotice className="mt-2" />;
      return (
        <p className="mt-2 text-state-danger-ink" role="alert">
          {t("smartActions.reply.draftError")}
        </p>
      );
    }
    return (
      <p className="mt-2 text-role-caption text-ink-mid" role="status">
        {t("smartActions.reply.drafting")}
      </p>
    );
  }

  const body = edited ?? shown.body;

  if (send.isSuccess) {
    return (
      <div className="mt-2 rounded-card border border-line/70 bg-surface-panel p-3" role="status">
        <p className="text-state-ok-ink">{t("smartActions.reply.sent")}</p>
        <p className="mt-0.5 font-mono text-role-caption text-ink-muted">
          {t("smartActions.reply.receipt", {
            hash: send.data.receipt.payloadHash.slice(0, RECEIPT_PREFIX_CHARS),
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-card border border-line/70 bg-surface-panel p-3 text-role-body">
      <span className="inline-flex rounded-chip bg-accent/10 px-1.5 py-0.5 text-role-caption font-bold uppercase tracking-wide text-accent-deep ring-1 ring-inset ring-accent/20">
        {t("smartActions.reply.title")}
      </span>
      <p className="mt-1.5 break-all text-ink-mid">
        {t("smartActions.reply.to", { to: shown.to })}
      </p>
      <p className="mt-0.5 text-ink-mid [word-break:keep-all]">
        {t("smartActions.reply.subject", { subject: shown.subject })}
      </p>
      <p className="mt-1.5 text-role-caption text-ink-muted">
        {t(
          shown.source === "proactive"
            ? "smartActions.reply.sourceProactive"
            : "smartActions.reply.sourceGenerated",
        )}
      </p>
      <label htmlFor={bodyId} className="mt-2 block text-role-label text-ink">
        {t("smartActions.reply.bodyLabel")}
      </label>
      <textarea
        id={bodyId}
        value={body}
        onChange={(event) => setEdited(event.target.value)}
        disabled={send.isPending}
        rows={8}
        className="focus-ring mt-1 w-full resize-y rounded-control border border-line bg-surface-raised p-2 text-role-body text-ink"
      />
      <p className="mt-2 text-role-caption text-ink-mid">{t("smartActions.reply.approval")}</p>
      {send.isError &&
        (isEntitlementRefusal(send.error) ? (
          <ProFeatureNotice className="mt-2" />
        ) : (
          <p className="mt-2 text-state-danger-ink" role="alert">
            {t(sendErrorKey(send.error))}
          </p>
        ))}
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="primary"
          size="md"
          loading={send.isPending}
          disabled={send.isPending || draft.isFetching || body.trim() === ""}
          onClick={() => send.mutate(replySendRequest(shown, body))}
        >
          {send.isPending ? t("smartActions.reply.sending") : t("smartActions.reply.send")}
        </Button>
      </div>
    </div>
  );
}
