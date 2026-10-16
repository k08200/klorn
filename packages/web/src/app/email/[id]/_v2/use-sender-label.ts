"use client";

/**
 * The reader's sender label correction: an optimistic write to the reader
 * context, rolled back with a toast when the server refuses, then a refresh of
 * everything under `queryKeys.email.all` (reader context, list rows, lane
 * counts) so the label reads the same everywhere. The request itself is
 * sender-label-model.ts's; the server scopes it to the signed-in user.
 */

import type { ReaderSenderLabel } from "@klorn/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../../../components/toast";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { queryKeys } from "../../../../lib/query-keys";
import { captureClientError } from "../../../../lib/sentry";
import {
  applySenderLabelChange,
  type SenderLabelChange,
  senderLabelRequest,
} from "./sender-label-model";
import type { ReaderContext } from "./use-reader-context";

interface Variables {
  emailId: string;
  label: ReaderSenderLabel;
  change: SenderLabelChange;
}

/** A clear that finds nothing is already what the user asked for. */
const isMissingLabel = (err: unknown) => err instanceof Error && err.message.startsWith("API 404");

export function useSenderLabelCorrection(emailId: string | undefined, reader: ReaderContext) {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { setSenderLabel } = reader;

  const mutation = useMutation({
    mutationFn: async ({ label, change }: Variables) => {
      const request = senderLabelRequest(label, change);
      if (!request) throw new Error(`No ${change.scope} to label`);
      try {
        await apiFetch<unknown>(request.path, { method: request.method, body: request.body });
      } catch (err) {
        if (change.kind === "clear" && isMissingLabel(err)) return;
        throw err;
      }
    },
    onMutate: ({ emailId: target, label, change }) => {
      setSenderLabel(target, applySenderLabelChange(label, change));
    },
    onError: (err, { emailId: target, label }) => {
      setSenderLabel(target, label);
      captureClientError(err, { scope: "email.v2.senderLabel", id: target });
      toast(t("mailV2.reader.label.failed"), "error");
    },
    onSuccess: (_data, { label, change }) => {
      if (change.kind === "clear") {
        toast(t("mailV2.reader.label.cleared"), "success");
        return;
      }
      const name = t(`mailV2.label.category.${change.category}`);
      toast(
        change.scope === "sender"
          ? t("mailV2.reader.label.savedSender", { address: label.address, label: name })
          : t("mailV2.reader.label.savedDomain", { domain: label.domain ?? "", label: name }),
        "success",
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.email.all });
    },
  });

  const label = reader.context?.senderLabel ?? null;
  return {
    label,
    busy: mutation.isPending,
    correct: (change: SenderLabelChange) => {
      if (!emailId || !label || mutation.isPending) return;
      mutation.mutate({ emailId, label, change });
    },
  };
}
