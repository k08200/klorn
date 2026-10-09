"use client";

/**
 * Reject, with an optional reason. The reason goes to the same endpoint field
 * the legacy dialog fills (at most 500 characters) and helps Klorn stop
 * proposing the same thing; leaving it empty sends a bare reject.
 */

import { useEffect, useRef, useState } from "react";
import Button from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/input";
import { Sheet } from "../../../components/ui/sheet";
import { useT } from "../../../lib/i18n";

/** rejectActionBodySchema in the API (chat-pending-actions.ts). */
const MAX_REASON_LENGTH = 500;

interface RejectSheetProps {
  /** What is being rejected, or null when the sheet is closed. */
  subject: string | null;
  onCancel: () => void;
  onReject: (reason: string | null) => void;
}

export function RejectSheet({ subject, onCancel, onReject }: RejectSheetProps) {
  const { t } = useT();
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const open = subject !== null;
  // A sheet opened for another card starts empty.
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={t("assistantHub.reject.title")}
      description={subject ?? undefined}
      closeLabel={t("keys.sheet.close")}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("assistantHub.reject.cancel")}
          </Button>
          <Button variant="danger" onClick={() => onReject(reason.trim() || null)}>
            {t("assistantHub.approvals.reject")}
          </Button>
        </>
      }
    >
      <Textarea
        ref={inputRef}
        id="approval-reject-reason"
        label={t("assistantHub.reject.reasonLabel")}
        rows={3}
        maxLength={MAX_REASON_LENGTH}
        value={reason}
        onChange={(event) => setReason(event.target.value.slice(0, MAX_REASON_LENGTH))}
        placeholder={t("assistantHub.reject.reasonPlaceholder")}
      />
      <p className="mt-2 text-caption text-ink-muted [word-break:keep-all]">
        {t("assistantHub.reject.undoHint")}
      </p>
    </Sheet>
  );
}
