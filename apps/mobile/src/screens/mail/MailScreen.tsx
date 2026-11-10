/**
 * Mail: the list and the reader, laid out by the shell's plan —
 *
 *   compact            one pane: the reader (or Subscriptions) when open, else the list
 *   medium / expanded  list | reader (ListDetail), the divider on the hinge when folded
 *   tabletop           reading above the hinge, writing (the reply) below it
 *
 * The open mail is the route (/mail/:id — also what a push tap opens), so a
 * rotation, fold or window resize re-lays out without losing it. The account
 * filter, search and multi-select live here, above the panes, so they survive
 * the same changes.
 */
import type { EmailListItem, FirewallResponse, InboxOption, LiveTier } from "@klorn/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isApiError } from "../../api/client";
import type { InboxScope } from "../../api/endpoints";
import { useFirewall, useInboxes, useLaneCounts, useMe } from "../../api/queries";
import { getServices } from "../../app/services";
import { useI18n } from "../../i18n/I18nProvider";
import { useLayout } from "../../layout/LayoutContext";
import { ListDetail } from "../../layout/ListDetail";
import { useRouter } from "../../router/Router";
import type { LaneParam, MailView } from "../../router/routes";
import { Snackbar } from "../../ui/Snackbar";
import { EmptyState } from "../../ui/StateView";
import { useOnline } from "../../ui/useOnline";
import {
  type ComposerMode,
  ComposerSheet,
  ConfirmSendSheet,
  type OutgoingMail,
  ProGateSheet,
  ReplyForm,
  WriteError,
} from "./compose";
import { MailProvider, type MailTarget, targetOf, useMail } from "./controller";
import { inLane, mailKeys, useMailFeed, useSubscriptions } from "./data";
import { useHiddenMail } from "./hidden-store";
import { blockState, MailList } from "./MailList";
import {
  attentionByEmail,
  flattenPages,
  mailWriteBlocked,
  PRO_REFUSAL_KEY,
  sendableAccounts,
  senderLabel,
  visibleRows,
} from "./model";
import { Reader } from "./Reader";
import { SubscriptionsScreen } from "./SubscriptionsScreen";
import {
  AccountSheet,
  type ActionItem,
  ActionSheet,
  LaneSheet,
  type LaneSheetRequest,
  SnoozeSheet,
} from "./sheets";
import "./mail-tokens.css";
import "./mail.css";
import "./reader.css";
import "./subscriptions.css";

/** The account filter outlives the screen for the session (tab switches, re-layouts). */
let sessionInbox: InboxScope = "all";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export interface ReplyDraft {
  emailId: string;
  to: string;
  subject: string;
  body: string;
  from: InboxOption | null;
}

export function MailScreen(props: { lane?: LaneParam; id?: string; view?: MailView }) {
  return (
    <MailProvider>
      <MailScreenBody {...props} />
    </MailProvider>
  );
}

function MailScreenBody({
  lane = "ALL",
  id,
  view,
}: {
  lane?: LaneParam;
  id?: string;
  view?: MailView;
}) {
  const { t, tn } = useI18n();
  const plan = useLayout();
  const { navigate } = useRouter();
  const qc = useQueryClient();
  const mail = useMail();
  const online = useOnline();
  const now = useMinuteClock();

  const [inbox, setInboxState] = useState<InboxScope>(sessionInbox);
  const setInbox = useCallback((next: InboxScope) => {
    sessionInbox = next;
    setInboxState(next);
  }, []);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput.trim(), 300);
  const [selection, setSelection] = useState<Set<string> | null>(null);

  const [laneRequest, setLaneRequest] = useState<LaneSheetRequest | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [rowActions, setRowActions] = useState<EmailListItem | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [snoozeTarget, setSnoozeTarget] = useState<MailTarget | null>(null);
  const [composer, setComposer] = useState<ComposerMode | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingMail | null>(null);
  const [tabletopDraft, setTabletopDraft] = useState<{
    body: string;
    to: string;
    subject: string;
  } | null>(null);

  const me = useMe();
  // An account that may not send gets the reason + plans link, not an editor.
  const writeBlocked = mailWriteBlocked(me.data);
  const [proGate, setProGate] = useState(false);
  const openComposer = (mode: ComposerMode) =>
    writeBlocked ? setProGate(true) : setComposer(mode);
  const openOutgoing = (mail: OutgoingMail) =>
    writeBlocked ? setProGate(true) : setOutgoing(mail);
  const inboxesQuery = useInboxes();
  const inboxes = useMemo(() => inboxesQuery.data?.inboxes ?? [], [inboxesQuery.data]);
  // A filter on an account that is no longer connected falls back to all.
  useEffect(() => {
    if (
      inbox !== "all" &&
      inboxesQuery.data &&
      !inboxes.some((i) => (i.id ?? "primary") === inbox)
    ) {
      setInbox("all");
    }
  }, [inbox, inboxes, inboxesQuery.data, setInbox]);

  const feed = useMailFeed(lane, inbox, search);
  const counts = useLaneCounts(inbox);
  const firewall = useFirewall();
  const subs = useSubscriptions();
  const hidden = useHiddenMail();

  const rows = useMemo(() => {
    const all = flattenPages(feed.data?.pages ?? []);
    return visibleRows(
      all.filter((e) => inLane(e, lane)),
      hidden,
      now.getTime(),
    );
  }, [feed.data, lane, hidden, now]);
  const reasons = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [emailId, facts] of attentionByEmail(
      firewall.data as FirewallResponse | undefined,
    )) {
      if (facts.tierReason) map.set(emailId, facts.tierReason);
    }
    return map;
  }, [firewall.data]);

  // Leaving a lane / account / search drops the selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the trigger
  useEffect(() => setSelection(null), [lane, inbox, search]);

  const listState = blockState(feed);
  const firstPage = feed.data?.pages[0];
  const anyOffline = feed.isError && isApiError(feed.error) && feed.error.isOffline;
  const primary = inboxes.find((i) => i.kind === "primary") ?? null;
  const senders = useMemo(() => sendableAccounts(inboxes), [inboxes]);

  const refresh = useCallback(async () => {
    try {
      const res = await getServices().ep.mail.sync();
      if (res?.error) mail.showError(t("mail.error.sync"));
    } catch {
      // Offline or rate-limited: the refetch below still shows what is cached.
    }
    await Promise.all([
      qc.refetchQueries({ queryKey: mailKeys.feed(lane, inbox, search) }),
      counts.refetch(),
      firewall.refetch(),
    ]);
  }, [qc, lane, inbox, search, counts, firewall, mail, t]);

  const backToList = useCallback(
    () => navigate(lane === "ALL" ? { name: "mail" } : { name: "mail", lane }),
    [navigate, lane],
  );
  const openMail = useCallback(
    (mailId: string) =>
      navigate(lane === "ALL" ? { name: "mail", id: mailId } : { name: "mail", lane, id: mailId }, {
        replace: Boolean(id),
      }),
    [navigate, lane, id],
  );

  /** After Done / Later / a move out of this lane, the reader steps on (wide) or closes. */
  const leaveReader = useCallback(
    (mailId: string) => {
      if (id !== mailId) return;
      const i = rows.findIndex((r) => r.id === mailId);
      const next = rows[i + 1] ?? rows[i - 1];
      if (plan.panes === 2 && next) openMail(next.id);
      else backToList();
    },
    [id, rows, plan.panes, openMail, backToList],
  );

  const doDone = (targets: MailTarget[]) => {
    for (const m of targets) leaveReader(m.id);
    mail.done(targets);
  };

  const submitLane = async (tier: LiveTier, pin: boolean) => {
    const targets = laneRequest?.targets ?? [];
    const ok = await mail.moveLane(targets, tier, pin);
    if (ok) {
      setSelection(null);
      if (lane !== "ALL" && tier !== lane) for (const m of targets) leaveReader(m.id);
    }
    return ok;
  };

  const startSelect = (email: EmailListItem) => setSelection(new Set([email.id]));
  const toggleSelect = (email: EmailListItem) =>
    setSelection((s) => {
      const next = new Set(s ?? []);
      if (next.has(email.id)) next.delete(email.id);
      else next.add(email.id);
      return next;
    });
  const selectedTargets = () => rows.filter((r) => selection?.has(r.id)).map(targetOf);

  const listPane = (
    <MailList
      lane={lane}
      inbox={inbox}
      inboxes={inboxes}
      search={searchInput}
      onSearch={setSearchInput}
      rows={rows}
      reasons={reasons}
      counts={counts.data?.counts}
      state={{
        ...listState,
        refetching: feed.isRefetching,
        hasMore: Boolean(feed.hasNextPage),
        loadingMore: feed.isFetchingNextPage,
        showBanner: Boolean(feed.data) && (!online || anyOffline),
        needsConnection: firstPage?.needsConnection === true || me.data?.hasAnyMailSource === false,
      }}
      selectedId={id}
      selection={selection}
      now={now}
      onRefresh={refresh}
      onLoadMore={() => void feed.fetchNextPage()}
      onRetry={() => void feed.refetch()}
      onOpenAccounts={() => setAccountsOpen(true)}
      onOpenMenu={() => setMenuOpen(true)}
      onCompose={() => openComposer({ kind: "new", to: "", from: primary })}
      onDone={(email) => doDone([targetOf(email)])}
      onLane={(email, origin) => setLaneRequest({ targets: [targetOf(email)], origin })}
      onRowActions={setRowActions}
      onStartSelect={startSelect}
      onToggleSelect={toggleSelect}
      onSelectionDone={() => {
        doDone(selectedTargets());
        setSelection(null);
      }}
      onSelectionLane={() => setLaneRequest({ targets: selectedTargets(), origin: "menu" })}
      onSelectionCancel={() => setSelection(null)}
    />
  );

  const readerProps = {
    view: { tier: lane, inbox, search },
    rows,
    inboxes,
    onBack: backToList,
    onOpen: openMail,
    onDone: (m: MailTarget) => doDone([m]),
    onLane: (m: MailTarget) => setLaneRequest({ targets: [m], origin: "menu" }),
    onLater: (m: MailTarget) => setSnoozeTarget(m),
    onReply: (r: ReplyDraft) => openComposer({ kind: "reply", ...r }),
    onReview: (r: ReplyDraft) => openOutgoing({ kind: "reply", ...r }),
    onMailto: (address: string) => openComposer({ kind: "new", to: address, from: primary }),
  };

  const detail =
    view === "subscriptions" ? (
      <SubscriptionsScreen onBack={backToList} />
    ) : id ? (
      <Reader key={id} id={id} {...readerProps} />
    ) : null;

  const emptyDetail = (
    <div className="reader reader--empty">
      <EmptyState tone="neutral" icon="mail" title={t("mail.selectPrompt")} />
    </div>
  );

  let panes: React.ReactNode;
  if (plan.posture === "tabletop" && id && !view) {
    // FoldTabletop: read above the hinge, write below it.
    const target = tabletopDraft;
    panes = (
      <div className="panes panes--tabletop">
        <section className="pane pane--detail" aria-label={t("reader.label")}>
          <Reader key={id} id={id} {...readerProps} inlineDraft onDraft={setTabletopDraft} />
        </section>
        <div className="panes__hinge" aria-hidden="true">
          <span className="panes__hinge-grip" />
        </div>
        <section className="pane pane--compose" aria-label={t("reader.draft.panelTitle")}>
          <div className="tabletop-compose">
            {writeBlocked ? (
              <p className="form-note" role="status">
                <WriteError messageKey={PRO_REFUSAL_KEY} />
              </p>
            ) : (
              <ReplyForm
                key={`${id}:${target ? "draft" : "none"}`}
                emailId={id}
                layout="panel"
                initial={target?.body ?? ""}
                replyTo={target?.to ?? ""}
                subject={target?.subject ?? ""}
                onReview={(body) =>
                  target &&
                  setOutgoing({
                    kind: "reply",
                    emailId: id,
                    to: target.to,
                    subject: target.subject,
                    body,
                    from: null,
                  })
                }
              />
            )}
          </div>
        </section>
      </div>
    );
  } else {
    panes = (
      <ListDetail
        list={listPane}
        detail={detail}
        emptyDetail={emptyDetail}
        listLabel={t("tab.mail")}
        detailLabel={view === "subscriptions" ? t("subs.title") : t("reader.label")}
      />
    );
  }

  const rowItems: ActionItem[] = rowActions
    ? [
        {
          key: "done",
          icon: "done",
          label: t("mail.action.done"),
          hint: t("mail.action.doneHint"),
          run: () => doDone([targetOf(rowActions)]),
        },
        {
          key: "lane",
          icon: "lane",
          label: t("mail.action.lane"),
          hint: rowActions.tier ? t("mail.action.laneHint", { lane: rowActions.tier }) : undefined,
          run: () => setLaneRequest({ targets: [targetOf(rowActions)], origin: "menu" }),
        },
        {
          key: "later",
          icon: "later",
          label: t("reader.action.later"),
          run: () => setSnoozeTarget(targetOf(rowActions)),
        },
        {
          key: "select",
          icon: "select",
          label: t("mail.select.start"),
          run: () => startSelect(rowActions),
        },
      ]
    : [];
  const menuItems: ActionItem[] = [
    ...(subs.data
      ? [
          {
            key: "subs",
            icon: "unsubscribe" as const,
            label: t("subs.title"),
            hint: tn("subs.menuHint", subs.data.subscriptions.length),
            run: () => navigate({ name: "mail", view: "subscriptions" }),
          },
        ]
      : []),
    {
      key: "select",
      icon: "select",
      label: t("mail.select.start"),
      run: () => setSelection(new Set()),
    },
    {
      key: "sync",
      icon: "inbox",
      label: t("mail.menu.sync"),
      hint: t("mail.menu.syncHint"),
      run: () => void refresh().then(() => mail.showNotice(t("mail.menu.synced"))),
    },
  ];

  const snack = mail.error
    ? { message: mail.error, tone: "error" as const, onClose: mail.clearError }
    : mail.snackbar
      ? {
          message: mail.snackbar.message,
          tone: "neutral" as const,
          actionLabel: t("mail.snackbar.undo"),
          onAction: mail.undo,
          onClose: mail.dismissSnackbar,
        }
      : mail.notice
        ? { message: mail.notice, tone: "neutral" as const }
        : null;

  const readerOpen = plan.panes === 1 && Boolean(id || view);
  return (
    <div
      className="mail-screen"
      data-snackbar={snack ? "true" : undefined}
      data-reader={readerOpen ? "true" : undefined}
      data-selecting={selection ? "true" : undefined}
    >
      {panes}
      <Snackbar
        message={snack?.message ?? null}
        tone={snack?.tone}
        actionLabel={snack && "actionLabel" in snack ? snack.actionLabel : undefined}
        onAction={snack && "onAction" in snack ? snack.onAction : undefined}
        onClose={snack && "onClose" in snack ? snack.onClose : undefined}
      />
      <LaneSheet request={laneRequest} onClose={() => setLaneRequest(null)} onSubmit={submitLane} />
      <AccountSheet
        open={accountsOpen}
        inbox={inbox}
        inboxes={inboxes}
        onClose={() => setAccountsOpen(false)}
        onChoose={setInbox}
      />
      <ActionSheet
        open={rowActions !== null}
        title={t("mail.row.actionsTitle")}
        subtitle={
          rowActions ? `${senderLabel(rowActions.from)} · ${rowActions.subject}` : undefined
        }
        items={rowItems}
        onClose={() => setRowActions(null)}
      />
      <ActionSheet
        open={menuOpen}
        title={t("mail.menu.title")}
        items={menuItems}
        onClose={() => setMenuOpen(false)}
      />
      <SnoozeSheet
        target={snoozeTarget}
        now={now}
        onClose={() => setSnoozeTarget(null)}
        onChoose={(until) => {
          if (!snoozeTarget) return;
          leaveReader(snoozeTarget.id);
          mail.snooze(snoozeTarget, until);
        }}
      />
      <ComposerSheet
        open={composer !== null}
        mode={composer}
        accounts={senders}
        onClose={() => setComposer(null)}
        onReview={(m) => {
          setComposer(null);
          setOutgoing(m);
        }}
      />
      <ProGateSheet open={proGate} onClose={() => setProGate(false)} />
      <ConfirmSendSheet
        mail={outgoing}
        onClose={() => setOutgoing(null)}
        onEdit={() => {
          const m = outgoing;
          setOutgoing(null);
          if (!m) return;
          setComposer(
            m.kind === "reply" && m.emailId
              ? {
                  kind: "reply",
                  emailId: m.emailId,
                  to: m.to,
                  subject: m.subject,
                  body: m.body,
                  from: m.from,
                }
              : { kind: "new", to: m.to, subject: m.subject, body: m.body, from: m.from },
          );
        }}
        onSent={(m) => {
          if (m.emailId) void qc.invalidateQueries({ queryKey: ["mail", "detail", m.emailId] });
          void qc.invalidateQueries({ queryKey: mailKeys.feeds });
        }}
      />
    </div>
  );
}
