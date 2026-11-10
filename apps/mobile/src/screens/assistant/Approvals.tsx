/**
 * Approvals ("승인 N"): everything waiting for the user's decision. Each card
 * says exactly what approving does — the action, who it goes to, when, the
 * draft itself, why Klorn proposes it — and a send says it cannot be taken
 * back. Approve waits for the server (a send mints its ActionReceipt there);
 * reject asks for an optional reason first. Nothing is decided by a swipe.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { qk, usePendingApprovals } from "../../api/queries";
import { hk } from "../../api/queries-hub";
import { getServices } from "../../app/services";
import { formatClock, formatRelativeFromNow } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import { ListDetail } from "../../layout/ListDetail";
import { hapticSuccess } from "../../platform/haptics";
import { useLinkProps, useRouter } from "../../router/Router";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { EmptyState, ProblemState, SkeletonRows } from "../../ui/StateView";
import { notify } from "../../ui/StatusNote";
import { useNow } from "../../ui/useNow";
import { type ApprovalModel, approvalModel } from "./model";

function useDecisions() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.approvals }),
      queryClient.invalidateQueries({ queryKey: hk.receipt }),
    ]);
  const drop = (id: string) =>
    queryClient.setQueryData(qk.approvals, (prev: unknown) =>
      Array.isArray(prev) ? prev.filter((a: { id: string }) => a.id !== id) : prev,
    );
  return {
    busy,
    approve: async (model: ApprovalModel): Promise<boolean> => {
      if (busy) return false;
      setBusy(model.id);
      try {
        await getServices().ep.assistant.approve(model.id);
        hapticSuccess();
        drop(model.id);
        notify(t(model.sendsMail ? "assistant.approvals.sent" : "assistant.approvals.approved"));
        void refresh();
        return true;
      } catch {
        notify(t("assistant.approvals.failed"), "error");
        void refresh();
        return false;
      } finally {
        setBusy(null);
      }
    },
    reject: async (model: ApprovalModel, reason: string): Promise<boolean> => {
      setBusy(model.id);
      try {
        await getServices().ep.assistant.reject(model.id, reason);
        drop(model.id);
        notify(t("assistant.approvals.rejected"), "info");
        void refresh();
        return true;
      } catch {
        notify(t("assistant.approvals.failed"), "error");
        void refresh();
        return false;
      } finally {
        setBusy(null);
      }
    },
  };
}

function KindTile({ kind }: { kind: ApprovalModel["kind"] }) {
  return (
    <span className={`approval__icon approval__icon--${kind}`} aria-hidden="true">
      <Icon
        name={kind === "email" ? "pen" : kind === "calendar" ? "calendar" : "check"}
        size={18}
      />
    </span>
  );
}

function ApprovalCard({
  model,
  zone,
  full,
  selected,
  busy,
  onApprove,
  onReject,
}: {
  model: ApprovalModel;
  zone: string;
  full: boolean;
  selected: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t, intlTag } = useI18n();
  const now = useNow();
  const link = useLinkProps({ name: "assistant", section: "approvals", id: model.id });
  const title = t(model.titleKey);
  return (
    <article
      className="approval-card"
      data-full={full || undefined}
      data-selected={selected || undefined}
      aria-labelledby={`appr-${model.id}`}
    >
      <header className="approval-card__head">
        <KindTile kind={model.kind} />
        <span className="approval-card__kind">
          {model.undo ? t("assistant.approvals.undo", { action: title }) : title}
        </span>
        <span className="approval-card__ago">
          {formatRelativeFromNow(new Date(model.createdAt), now, intlTag)}
        </span>
      </header>
      {full ? (
        <h2 id={`appr-${model.id}`} className="approval-card__subject">
          {model.subject ?? title}
        </h2>
      ) : (
        <a id={`appr-${model.id}`} className="approval-card__subject approval-card__link" {...link}>
          {model.subject ?? title}
        </a>
      )}
      {model.facts.length ? (
        <dl className="draft-facts">
          {model.facts.map((fact, i) => (
            <div key={`${fact.labelKey ?? fact.label}-${i}`}>
              <dt>{fact.labelKey ? t(fact.labelKey) : fact.label}</dt>
              <dd>
                {fact.iso
                  ? `${new Intl.DateTimeFormat(intlTag, { month: "long", day: "numeric", weekday: "short", timeZone: zone }).format(new Date(fact.iso))} ${formatClock(new Date(fact.iso), intlTag, zone)}`
                  : fact.text}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {model.preview ? (
        <blockquote className="approval-card__preview selectable">
          <span className="approval-card__preview-label">
            {t(
              model.kind === "email" ? "assistant.approvals.draft" : "assistant.approvals.content",
            )}
          </span>
          {model.preview}
        </blockquote>
      ) : null}
      {model.why ? (
        <p className="approval-card__why">
          <span>{t("assistant.approvals.why")}</span> {model.why}
        </p>
      ) : null}
      {model.sendsMail ? (
        <p className="approval-card__warn">
          <Icon name="info" size={16} />
          {t("assistant.approvals.irreversible")}
        </p>
      ) : null}
      <footer className="approval-card__actions">
        <button type="button" className="button button--quiet" disabled={busy} onClick={onReject}>
          {t("assistant.approvals.reject")}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={onApprove}
          aria-label={`${t(model.sendsMail ? "assistant.approvals.send" : "assistant.approvals.approve")}: ${model.subject ?? title}`}
        >
          {busy
            ? t("assistant.approvals.working")
            : t(model.sendsMail ? "assistant.approvals.send" : "assistant.approvals.approve")}
        </button>
      </footer>
    </article>
  );
}

function RejectSheet({
  model,
  onClose,
  onConfirm,
}: {
  model: ApprovalModel | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return (
    <Sheet
      closeButton
      open={model !== null}
      onClose={onClose}
      title={t("assistant.reject.title")}
      subtitle={model?.subject ?? undefined}
      footer={
        <>
          <button type="button" className="button button--quiet" onClick={onClose}>
            {t("settings.ui.cancel")}
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              onConfirm(reason);
              setReason("");
            }}
          >
            {t("assistant.reject.confirm")}
          </button>
        </>
      }
    >
      <p className="form-field__hint">{t("assistant.reject.body")}</p>
      <label className="form-field">
        <span className="form-field__label">{t("assistant.reject.reason")}</span>
        <textarea
          rows={3}
          maxLength={500}
          value={reason}
          placeholder={t("assistant.reject.placeholder")}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
    </Sheet>
  );
}

export function ApprovalsView({
  id,
  zone,
  header,
}: {
  id?: string;
  zone: string;
  header: ReactNode;
}) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const query = usePendingApprovals();
  const decisions = useDecisions();
  const [rejecting, setRejecting] = useState<ApprovalModel | null>(null);
  const models = (query.data ?? []).map(approvalModel);
  const selected = id ? models.find((m) => m.id === id) : undefined;

  const after = (model: ApprovalModel) => {
    if (id === model.id) navigate({ name: "assistant", section: "approvals" }, { replace: true });
  };

  const card = (model: ApprovalModel, full: boolean) => (
    <ApprovalCard
      key={model.id}
      model={model}
      zone={zone}
      full={full}
      selected={!full && model.id === id}
      busy={decisions.busy === model.id}
      onApprove={() => void decisions.approve(model).then((ok) => ok && after(model))}
      onReject={() => setRejecting(model)}
    />
  );

  const list = (
    <div className="assistant-pane">
      {header}
      <div className="assistant-scroll">
        {query.isError && !query.data ? (
          <ProblemState kind="error" onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows rows={3} />
        ) : models.length === 0 ? (
          <EmptyState
            title={t("assistant.approvals.empty")}
            body={t("assistant.approvals.emptyBody")}
          />
        ) : (
          <div className="approval-list">{models.map((m) => card(m, false))}</div>
        )}
      </div>
    </div>
  );

  const detail = id ? (
    <div className="screen approval-detail">
      <button
        type="button"
        className="detail-back"
        onClick={() => navigate({ name: "assistant", section: "approvals" })}
      >
        <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
        {t("assistant.segment.approvalsShort")}
      </button>
      {selected ? (
        card(selected, true)
      ) : query.data ? (
        <EmptyState tone="neutral" icon="check" title={t("assistant.approvals.gone")} />
      ) : (
        <SkeletonRows rows={2} />
      )}
    </div>
  ) : null;

  return (
    <>
      <ListDetail
        list={list}
        detail={detail}
        emptyDetail={
          <div className="screen pane-empty">
            <EmptyState tone="neutral" icon="check" title={t("assistant.approvals.pick")} />
          </div>
        }
        listLabel={t("assistant.segment.approvalsShort")}
        detailLabel={t("assistant.approvals.detail")}
      />
      <RejectSheet
        model={rejecting}
        onClose={() => setRejecting(null)}
        onConfirm={(reason) => {
          const model = rejecting;
          setRejecting(null);
          if (model) void decisions.reject(model, reason).then((ok) => ok && after(model));
        }}
      />
    </>
  );
}
