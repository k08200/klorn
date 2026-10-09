"use client";

/**
 * Approvals (productization plan §1, P7, FD-1) — everything waiting for the
 * user's yes or no: the proposed actions as cards, then the two quieter lists
 * that moved here with them (first-contact senders, commitments). Nothing
 * lands on this page unless it needs a decision; the lane view lives in Mail
 * (FD-3) and the record of what already happened is Activity.
 */

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import Button from "../../../components/ui/button";
import EmptyState from "../../../components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { useScreener } from "../../../lib/use-screener";
import { UndoBar } from "../../email/_v2/undo-bar";
import { BlockError } from "../../today/block";
import { HubHeader, RefreshGlyph } from "../hub-frame";
import { AgentModeLine } from "./agent-mode-line";
import { ApprovalCard } from "./approval-card";
import { type ApprovalModel, approvalModel } from "./model";
import { RejectSheet } from "./reject-sheet";
import { CommitmentsSection, ScreenerSection } from "./side-sections";
import { useApprovalDecisions } from "./use-approval-decisions";
import { useApprovals, useOpenCommitments } from "./use-approvals";

const DEFAULT_TIME_ZONE = "Asia/Seoul";
const MAIL_HREF = "/email";

export function ApprovalsView() {
  const { t } = useT();
  const approvals = useApprovals();
  const commitments = useOpenCommitments();
  const screener = useScreener();
  const senders = screener.pending ?? [];
  const models = useMemo(() => approvals.actions.map(approvalModel), [approvals.actions]);
  const decisions = useApprovalDecisions(models, approvals);
  const settled = !approvals.loading && !approvals.failed;
  const hasSide = senders.length > 0 || commitments.length > 0;

  return (
    <div className="pb-8">
      <HubHeader
        title={t("nav.v2.approvals")}
        subtitle={settled ? <WaitingCount count={models.length} /> : undefined}
        actions={
          <Button
            variant="secondary"
            size="icon"
            aria-label={t("assistantHub.approvals.refresh")}
            title={t("assistantHub.approvals.refresh")}
            disabled={approvals.refreshing}
            onClick={() => void approvals.refresh()}
          >
            <RefreshGlyph spinning={approvals.refreshing} />
          </Button>
        }
      />
      <AgentModeLine />

      <div
        className={`mt-4 flex flex-col gap-8 ${
          hasSide ? "xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start xl:gap-x-10" : ""
        }`}
      >
        <section aria-labelledby="hub-approvals-list" className="min-w-0 max-w-3xl">
          <h2 id="hub-approvals-list" className="sr-only">
            {t("assistantHub.approvals.listLabel")}
          </h2>
          {approvals.loading && <CardsSkeleton label={t("today.approvals.loading")} />}
          {approvals.failed && (
            <BlockError message={t("today.approvals.error")} onRetry={approvals.retry} />
          )}
          {settled && (
            <ApprovalList models={models} approving={approvals.approving} decisions={decisions} />
          )}
        </section>

        {hasSide && (
          <div className="flex min-w-0 max-w-3xl flex-col gap-8">
            <ScreenerSection
              senders={senders}
              deciding={screener.deciding}
              onDecide={screener.decide}
            />
            <CommitmentsSection commitments={commitments} />
          </div>
        )}
      </div>

      <RejectSheet
        subject={decisions.rejectingLabel}
        onCancel={decisions.cancelReject}
        onReject={decisions.confirmReject}
      />
      {approvals.held && (
        <UndoBar
          title={t("assistantHub.approvals.rejected")}
          detail={approvals.held.label}
          undoLabel={t("keys.undo")}
          busy={false}
          onUndo={approvals.undoReject}
          onDismiss={approvals.settleReject}
        />
      )}
    </div>
  );
}

interface ApprovalListProps {
  models: readonly ApprovalModel[];
  /** The card whose approval is on its way to the server, if any. */
  approving: string | null;
  decisions: ReturnType<typeof useApprovalDecisions>;
}

function ApprovalList({ models, approving, decisions }: ApprovalListProps) {
  const { t } = useT();
  const router = useRouter();
  const timeZone = useAuth().user?.timezone ?? DEFAULT_TIME_ZONE;
  if (models.length === 0) {
    return (
      <EmptyState
        headingLevel="h3"
        icon={<CheckGlyph />}
        title={t("assistantHub.approvals.empty.title")}
        description={t("assistantHub.approvals.empty.body")}
        action={
          <Button variant="secondary" onClick={() => router.push(MAIL_HREF)}>
            {t("assistantHub.approvals.empty.action")}
          </Button>
        }
        className="rounded-card border border-line"
      />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {models.map((model) => (
        <li key={model.id}>
          <ApprovalCard
            model={model}
            selected={model.id === decisions.current}
            expanded={decisions.expanded.has(model.id)}
            onToggleExpanded={() => decisions.toggleExpanded(model.id)}
            approving={approving === model.id}
            disabled={approving !== null && approving !== model.id}
            onApprove={() => void decisions.approve(model)}
            onReject={() => decisions.startReject(model)}
            timeZone={timeZone}
          />
        </li>
      ))}
    </ul>
  );
}

/** The header's count, announced politely when a decision changes it. */
function WaitingCount({ count }: { count: number }) {
  const { t } = useT();
  return (
    <span aria-live="polite">
      {count === 0
        ? t("today.approvals.none")
        : count === 1
          ? t("today.approvals.one")
          : t("today.approvals.many", { count: String(count) })}
    </span>
  );
}

function CardsSkeleton({ label }: { label: string }) {
  return (
    <SkeletonGroup label={label} className="flex flex-col gap-3">
      {["a", "b"].map((key) => (
        <div key={key} className="flex flex-col gap-3 rounded-card border border-line p-4 md:p-5">
          <Skeleton width="w-32" />
          <Skeleton width="w-2/3" />
          <Skeleton variant="block" height="h-16" />
          <Skeleton width="w-40" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

function CheckGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}
