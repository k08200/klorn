"use client";

/**
 * Which card is picked, which drafts are open, and what approve / reject do to
 * that — for the pointer and for the keyboard alike. The keys (j / k, a, x,
 * o) come from the HOTKEYS table and exist only with KEYBOARD_TRIAGE; approve
 * and reject answer only for a card the user picked with j / k first, so a
 * stray key never approves anything.
 */

import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { useHotkeys, useKeyboardTriage } from "../../../lib/use-hotkeys";
import { approvalDomId } from "./approval-card";
import { type ApprovalModel, nextSelection } from "./model";
import type { useApprovals } from "./use-approvals";

type Approvals = ReturnType<typeof useApprovals>;

export function useApprovalDecisions(models: readonly ApprovalModel[], approvals: Approvals) {
  const { t } = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [rejecting, setRejecting] = useState<ApprovalModel | null>(null);

  const ids = models.map((model) => model.id);
  const current = selected !== null && ids.includes(selected) ? selected : null;
  const picked = models.find((model) => model.id === current) ?? null;
  const labelOf = (model: ApprovalModel) => model.subject ?? t(model.titleKey);

  // Selection moved by key: bring the card into view and tell assistive tech.
  useEffect(() => {
    if (!current) return;
    const card = document.getElementById(approvalDomId(current));
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
  }, [current]);

  /** The selection after `id` leaves the list: its neighbour, if it was picked. */
  const afterLeaving = (id: string): string | null => {
    if (current !== id) return current;
    const index = ids.indexOf(id);
    return ids[index + 1] ?? ids[index - 1] ?? null;
  };

  const approve = async (model: ApprovalModel) => {
    const next = afterLeaving(model.id);
    if (await approvals.approve(model.id, model.sendsMail)) setSelected(next);
  };

  const confirmReject = (reason: string | null) => {
    if (!rejecting) return;
    setSelected(afterLeaving(rejecting.id));
    approvals.reject({ id: rejecting.id, label: labelOf(rejecting), reason });
    setRejecting(null);
  };

  const toggleExpanded = (id: string) =>
    setExpanded(
      (prev) => new Set(prev.has(id) ? [...prev].filter((x) => x !== id) : [...prev, id]),
    );

  const noPick = () => (picked ? null : t("keys.reason.noApproval"));
  const notReady = () => noPick() ?? (approvals.approving ? t("keys.reason.busy") : null);
  useHotkeys(
    "approvals",
    {
      "approvals.next": { run: () => setSelected(nextSelection(ids, current, 1)) },
      "approvals.prev": { run: () => setSelected(nextSelection(ids, current, -1)) },
      "approvals.expand": {
        run: () => picked && toggleExpanded(picked.id),
        disabledReason: noPick,
      },
      "approvals.approve": { run: () => picked && void approve(picked), disabledReason: notReady },
      "approvals.reject": { run: () => picked && setRejecting(picked), disabledReason: notReady },
    },
    useKeyboardTriage(),
  );

  return {
    current,
    expanded,
    toggleExpanded,
    approve,
    rejecting,
    rejectingLabel: rejecting ? labelOf(rejecting) : null,
    startReject: setRejecting,
    cancelReject: () => setRejecting(null),
    confirmReject,
  };
}
