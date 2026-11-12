"use client";

/**
 * The Commitment Ledger on Approvals: "Confirmed" commitments, then the
 * rule-mined suggestions "To confirm", each grouped by owner and due
 * (commitments-model.ts). Every row links to the mail it came from and can be
 * settled in one tap: Confirm (suggestions), Done, Dismiss.
 *
 * Not the legacy CommitmentCard: its copy is English-only, its buttons are
 * under 44px, its "Snooze 24h" promises a resurfacing nothing implements (no
 * snooze time is stored, so a snoozed row never comes back), and its
 * fulfillment plan is a Pro LLM call per card — too heavy for a list of ~100
 * suggestions in a 340px column.
 *
 * Mail text (title, subject, evidence) is untrusted: it is only ever rendered
 * as React text, never as HTML.
 */

import Link from "next/link";
import { useState } from "react";
import type { CommitmentItem } from "../../../components/commitment-card";
import Button from "../../../components/ui/button";
import { useT } from "../../../lib/i18n";
import { formatRelativeIntl } from "../../../lib/text";
import { useDisplayTimeZone } from "../../../lib/use-time-zone";
import { BlockError } from "../../today/block";
import {
  BUCKET_ORDER,
  buildCommitmentLedger,
  type CommitmentBucket,
  evidenceQuote,
  type LedgerRow,
  type OwnerGroup,
  ownerGroupOf,
  sourceMailHref,
} from "./commitments-model";
import { SectionHeading } from "./side-sections";
import type { CommitmentAction, useCommitmentLedger } from "./use-commitments";

/** Rows an owner group shows before "Show N more". */
const VISIBLE_PER_OWNER = 5;

const KIND_KEYS: ReadonlyMap<CommitmentItem["kind"], string> = new Map([
  ["DELIVERABLE", "assistantHub.commitments.kind.deliverable"],
  ["FOLLOW_UP", "assistantHub.commitments.kind.followUp"],
  ["DECISION", "assistantHub.commitments.kind.decision"],
  ["MEETING", "assistantHub.commitments.kind.meeting"],
  ["REVIEW", "assistantHub.commitments.kind.review"],
]);

const OWNER_KEYS = {
  mine: "assistantHub.commitments.mine",
  theirs: "assistantHub.commitments.theirs",
} as const;

function bucketKey(bucket: CommitmentBucket, owner: OwnerGroup["owner"]): string {
  if (bucket === "likelyDone") return `assistantHub.commitments.bucket.likelyDone.${owner}`;
  return `assistantHub.commitments.bucket.${bucket}`;
}

type Ledger = ReturnType<typeof useCommitmentLedger>;
type Act = (id: string, action: CommitmentAction) => void;

export function CommitmentsSection({ ledger }: { ledger: Ledger }) {
  const { t } = useT();
  const timeZone = useDisplayTimeZone();
  if (ledger.failed) {
    return (
      <section aria-labelledby="hub-commitments">
        <SectionHeading
          id="hub-commitments"
          title={t("assistantHub.commitments.title")}
          count={0}
        />
        <BlockError message={t("assistantHub.commitments.loadFailed")} onRetry={ledger.retry} />
      </section>
    );
  }
  if (ledger.rows.length === 0) return null;
  const view = buildCommitmentLedger(ledger.rows, new Date(), timeZone);
  const act: Act = (id, action) => void ledger.act(id, action);
  const hasSuggested = view.suggested.owners.length > 0 || view.suggested.older.length > 0;
  return (
    <section aria-labelledby="hub-commitments" className="flex flex-col gap-4">
      <div>
        <SectionHeading
          id="hub-commitments"
          title={t("assistantHub.commitments.title")}
          count={ledger.rows.length}
        />
        <p className="pt-2 text-role-caption text-ink-muted [word-break:keep-all]">
          {t("assistantHub.commitments.hint")}
        </p>
      </div>
      {view.confirmed.owners.length > 0 && (
        <LedgerList
          id="hub-commitments-confirmed"
          title={t("assistantHub.commitments.confirmed.title")}
          owners={view.confirmed.owners}
          busy={ledger.busy}
          onAct={act}
        />
      )}
      {hasSuggested && (
        <LedgerList
          id="hub-commitments-suggested"
          title={t("assistantHub.commitments.suggested.title")}
          hint={t("assistantHub.commitments.suggested.hint")}
          owners={view.suggested.owners}
          older={view.suggested.older}
          busy={ledger.busy}
          onAct={act}
        />
      )}
    </section>
  );
}

interface ListProps {
  id: string;
  title: string;
  hint?: string;
  owners: OwnerGroup[];
  older?: CommitmentItem[];
  busy: Ledger["busy"];
  onAct: Act;
}

function LedgerList({ id, title, hint, owners, older = [], busy, onAct }: ListProps) {
  const { t } = useT();
  const [showOlder, setShowOlder] = useState(false);
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} className="text-role-label font-semibold text-ink">
        {title}
      </h3>
      {hint && (
        <p className="-mt-2 text-role-caption text-ink-muted [word-break:keep-all]">{hint}</p>
      )}
      {owners.map((group) => (
        <OwnerBlock key={group.owner} listId={id} group={group} busy={busy} onAct={onAct} />
      ))}
      {older.length > 0 && (
        <div>
          <Button
            variant="ghost"
            size="lg"
            className="-ml-3"
            aria-expanded={showOlder}
            aria-controls={`${id}-older`}
            onClick={() => setShowOlder((prev) => !prev)}
          >
            {showOlder
              ? t("assistantHub.commitments.olderHide")
              : t("assistantHub.commitments.olderShow", { count: String(older.length) })}
          </Button>
          {/* Always in the DOM so aria-controls names a real element; empty while collapsed. */}
          <ul id={`${id}-older`} hidden={!showOlder}>
            {showOlder &&
              older.map((row) => (
                <CommitmentRow key={row.id} row={row} showOwner busy={busy[row.id]} onAct={onAct} />
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function OwnerBlock(props: {
  listId: string;
  group: OwnerGroup;
  busy: Ledger["busy"];
  onAct: Act;
}) {
  const { listId, group, busy, onAct } = props;
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? group.rows : group.rows.slice(0, VISIBLE_PER_OWNER);
  const hidden = group.rows.length - rows.length;
  const headingId = `${listId}-${group.owner}`;
  return (
    <div>
      <h4 id={headingId} className="text-role-caption font-medium text-ink-soft">
        {t(OWNER_KEYS[group.owner])} · <span className="tabular-nums">{group.rows.length}</span>
      </h4>
      {segmentsOf(rows).map(({ bucket, rows: segment }) => (
        <div key={bucket}>
          <p
            id={`${headingId}-${bucket}`}
            className="pt-3 text-role-caption font-semibold uppercase tracking-wide text-ink-muted"
          >
            {t(bucketKey(bucket, group.owner))}
          </p>
          <ul aria-labelledby={`${headingId}-${bucket}`}>
            {segment.map((row) => (
              <CommitmentRow key={row.id} row={row} busy={busy[row.id]} onAct={onAct} />
            ))}
          </ul>
        </div>
      ))}
      {hidden > 0 && (
        <Button variant="ghost" size="lg" className="-ml-3" onClick={() => setExpanded(true)}>
          {t("assistantHub.commitments.showMore", { count: String(hidden) })}
        </Button>
      )}
    </div>
  );
}

/** The rows of each due bucket, in display order (BUCKET_ORDER). Pure. */
function segmentsOf(rows: readonly LedgerRow[]): { bucket: CommitmentBucket; rows: LedgerRow[] }[] {
  return BUCKET_ORDER.flatMap((bucket) => {
    const inBucket = rows.filter((row) => row.bucket === bucket);
    return inBucket.length > 0 ? [{ bucket, rows: inBucket }] : [];
  });
}

function CommitmentRow(props: {
  row: CommitmentItem;
  showOwner?: boolean;
  busy: CommitmentAction | undefined;
  onAct: Act;
}) {
  return (
    <li className="list-none">
      <CommitmentRowBody {...props} />
    </li>
  );
}

function CommitmentRowBody({
  row,
  showOwner = false,
  busy,
  onAct,
}: {
  row: CommitmentItem;
  showOwner?: boolean;
  busy: CommitmentAction | undefined;
  onAct: Act;
}) {
  const { t, locale } = useT();
  const timeZone = useDisplayTimeZone();
  const owner = ownerGroupOf(row);
  const kindKey = KIND_KEYS.get(row.kind);
  const due = row.dueText ?? (row.dueAt ? formatDay(row.dueAt, locale, timeZone) : null);
  const meta = [
    showOwner ? t(OWNER_KEYS[owner]) : null,
    kindKey ? t(kindKey) : null,
    due ? t("assistantHub.commitments.due", { when: due }) : null,
    formatRelativeIntl(row.createdAt, locale, t("assistantHub.justNow")),
  ].filter(Boolean);
  const quote = evidenceQuote(row);
  const href = sourceMailHref(row);
  const likely = row.completionSuggestedAt;
  return (
    <article className="border-b border-line-soft py-3 last:border-b-0">
      <p className="break-words text-role-body font-medium text-ink-strong">{row.title}</p>
      {quote && (
        <blockquote className="mt-1 border-l-2 border-line pl-2 text-role-caption text-ink-soft">
          <span className="sr-only">{t("assistantHub.commitments.evidenceLabel")}: </span>
          <span className="line-clamp-3 break-words">{quote}</span>
        </blockquote>
      )}
      <p className="mt-1 text-role-caption text-ink-muted">{meta.join(" · ")}</p>
      {likely && (
        <p className="mt-1 text-role-caption font-medium text-state-ok-ink">
          {t(`assistantHub.commitments.likelyDone.${owner}`, {
            when: formatRelativeIntl(likely, locale, t("assistantHub.justNow")),
          })}
        </p>
      )}
      {href && (
        <Link
          href={href}
          className="focus-ring -ml-1 inline-flex min-h-11 max-w-full items-center rounded-control px-1 text-role-caption text-accent-deep hover:underline"
        >
          <span className="min-w-0 truncate">
            {row.description
              ? t("assistantHub.commitments.source", { subject: row.description })
              : t("assistantHub.commitments.sourceNoSubject")}
          </span>
        </Link>
      )}
      <RowActions row={row} likely={Boolean(likely)} busy={busy} onAct={onAct} />
    </article>
  );
}

function RowActions({
  row,
  likely,
  busy,
  onAct,
}: {
  row: CommitmentItem;
  likely: boolean;
  busy: CommitmentAction | undefined;
  onAct: Act;
}) {
  const { t } = useT();
  const disabled = busy !== undefined;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {row.confirmed !== true && (
        <Button
          variant="secondary"
          size="lg"
          loading={busy === "confirm"}
          disabled={disabled}
          aria-label={t("assistantHub.commitments.confirmLabel", { title: row.title })}
          onClick={() => onAct(row.id, "confirm")}
        >
          {t("assistantHub.commitments.confirm")}
        </Button>
      )}
      <Button
        variant={likely ? "primary" : "secondary"}
        size="lg"
        loading={busy === "done"}
        disabled={disabled}
        aria-label={t("assistantHub.commitments.doneLabel", { title: row.title })}
        onClick={() => onAct(row.id, "done")}
      >
        {t("assistantHub.commitments.done")}
      </Button>
      <Button
        variant="ghost"
        size="lg"
        loading={busy === "dismiss"}
        disabled={disabled}
        aria-label={t("assistantHub.commitments.dismissLabel", { title: row.title })}
        onClick={() => onAct(row.id, "dismiss")}
      >
        {t("assistantHub.commitments.dismiss")}
      </Button>
    </div>
  );
}

function formatDay(iso: string, locale: string, timeZone: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone });
}
