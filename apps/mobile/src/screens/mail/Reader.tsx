/**
 * The reader (Reader artboard on phones; the detail pane of FoldOpen /
 * TabletLandscape; the top half of FoldTabletop): back / previous / next,
 * subject, sender with the account badge, the lane "why" card (tierReason),
 * what Klorn knows about the sender and the thread, the body (sanitized HTML
 * in a script-less frame, or text), attachments, the reply draft, and the
 * toolbar 답장 · 처리 완료 · 레인 변경 · 나중에.
 */
import type { FirewallResponse, InboxOption, LiveTier } from "@klorn/contract";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { InboxScope, LaneFilter } from "../../api/endpoints";
import { qk, useEmail, useFirewall } from "../../api/queries";
import type { EmailAttachmentWire, EmailDetailWire, ReplyDraftResponse } from "../../api/wire";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { useLayout } from "../../layout/LayoutContext";
import { RAIL_WIDTH, SIDEBAR_WIDTH } from "../../layout/size-class";
import { openExternal } from "../../platform/external";
import { MailGlyph, type MailGlyphName } from "../../ui/MailGlyph";
import { SourceBadge } from "../../ui/SourceBadge";
import { EmptyState, ProblemState } from "../../ui/StateView";
import { replyTarget, WriteError } from "./compose";
import type { MailTarget } from "./controller";
import {
  cachedRow,
  patchMailRead,
  useReaderContext,
  useSenderDossier,
  useThreadBrief,
} from "./data";
import { MailFrame } from "./MailFrame";
import {
  accountOf,
  attentionByEmail,
  avatarTone,
  draftErrorKey,
  monogram,
  neighbours,
  senderLabel,
  splitSender,
} from "./model";
import { useAccountLabel } from "./useAccountLabel";

const WHY_TITLE: Record<LiveTier, MessageKey> = {
  PUSH: "reader.why.push",
  MEETING: "reader.why.meeting",
  QUEUE: "reader.why.queue",
  INFO: "reader.why.info",
  SILENT: "reader.why.silent",
};

export interface ReaderProps {
  id: string;
  view: { tier: LaneFilter; inbox: InboxScope; search: string };
  /** The rows the list shows (prev / next walk them). */
  rows: ReadonlyArray<{ id: string }>;
  inboxes: readonly InboxOption[];
  onBack: () => void;
  onOpen: (id: string) => void;
  onDone: (target: MailTarget) => void;
  onLane: (target: MailTarget) => void;
  onLater: (target: MailTarget) => void;
  /** Open the composer on this reply (draft body, or empty). */
  onReply: (reply: {
    emailId: string;
    to: string;
    subject: string;
    body: string;
    from: InboxOption | null;
  }) => void;
  /** Straight to the confirm sheet with the draft as it stands. */
  onReview: (reply: {
    emailId: string;
    to: string;
    subject: string;
    body: string;
    from: InboxOption | null;
  }) => void;
  onMailto: (address: string) => void;
  /** Tabletop: the reply form sits in the lower half, not in the reader. */
  inlineDraft?: boolean;
  /** Reports the draft so the tabletop panel can show it. */
  onDraft?: (draft: { body: string; to: string; subject: string } | null) => void;
}

function humanSize(bytes: number | null, intlTag: string): string {
  if (bytes === null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(intlTag, { maximumFractionDigits: u ? 1 : 0 }).format(v)} ${units[u]}`;
}

function extLabel(filename: string): string {
  const ext = filename.split(".").pop() ?? "";
  return ext.length > 0 && ext.length <= 4 ? ext.toUpperCase() : "FILE";
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')]+/g;

/** Plain text with https links made tappable (system browser), everything else inert text. */
function PlainBody({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const url = m[0];
    parts.push(
      <a
        key={`${at}-${url}`}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          void openExternal(url.replace(/^http:/i, "https:"));
        }}
      >
        {url}
      </a>,
    );
    last = at + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <p className="reader__text selectable">{parts}</p>;
}

function Attachments({ email }: { email: EmailDetailWire }) {
  const { t, intlTag } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const list = email.attachments ?? [];
  if (list.length === 0) return null;
  const open = async (a: EmailAttachmentWire) => {
    setBusy(a.id);
    setFailed(null);
    try {
      const blob = await getServices().api.getBlob(
        getServices().ep.mail.attachmentPath(email.id, a.id),
      );
      const file = new File([blob], a.filename, { type: a.mimeType || blob.type });
      const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        await nav.share({ files: [file], title: a.filename });
      } else {
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = a.filename;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") setFailed(a.id);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="attachments" aria-label={t("reader.attachments.label")}>
      {list.map((a) => (
        <div key={a.id} className="attachment">
          <span className="attachment__tile" aria-hidden="true">
            {extLabel(a.filename)}
          </span>
          <span className="attachment__text">
            <span className="attachment__name">{a.filename}</span>
            <span className="attachment__sub">
              {failed === a.id
                ? t("reader.attachments.failed")
                : a.summary
                  ? t("reader.attachments.summary", { summary: a.summary })
                  : humanSize(a.size, intlTag)}
            </span>
          </span>
          <button
            type="button"
            className="attachment__open"
            onClick={() => void open(a)}
            disabled={busy !== null}
            aria-label={t("reader.attachments.open", { name: a.filename })}
          >
            <MailGlyph name="download" size={20} />
          </button>
        </div>
      ))}
    </section>
  );
}

function ContextLine({ icon, children }: { icon: MailGlyphName; children: ReactNode }) {
  return (
    <div className="reader-context__line">
      <MailGlyph name={icon} size={16} className="reader-context__icon" />
      <span>{children}</span>
    </div>
  );
}

export function Reader(props: ReaderProps) {
  const { id, view, rows, inboxes } = props;
  const { t, tn, locale, intlTag } = useI18n();
  const plan = useLayout();
  const qc = useQueryClient();
  const email = useEmail(id);
  const context = useReaderContext(id, view);
  const firewall = useFirewall();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lang = locale === "ko" ? "ko" : "en";

  const row = cachedRow(qc, id);
  const data = email.data;
  const ctx = context.data ?? null;
  const fw = useMemo(
    () => attentionByEmail(firewall.data as FirewallResponse | undefined).get(id),
    [firewall.data, id],
  );
  const tier: LiveTier | null = ctx?.tier ?? data?.tier ?? row?.tier ?? null;
  const tierReason = ctx?.tierReason ?? fw?.tierReason ?? null;
  const accountId = ctx ? ctx.linkedInboxAccountId : (row?.linkedInboxAccountId ?? null);
  const account = accountOf(accountId, inboxes);
  const labelOf = useAccountLabel(inboxes);
  const local = neighbours(rows, id);
  const newerId = rows.some((r) => r.id === id) ? local.newerId : (ctx?.newerId ?? null);
  const olderId = rows.some((r) => r.id === id) ? local.olderId : (ctx?.olderId ?? null);

  // Context costs an LLM call (cached server-side): only for mail that may need you.
  const wantsContext =
    tier === "PUSH" || tier === "MEETING" || (tier === "QUEUE" && Boolean(data?.needsReply));
  const brief = useThreadBrief(id, lang, Boolean(data) && wantsContext);
  const dossier = useSenderDossier(id, lang, Boolean(data) && wantsContext);

  // Draft: the proactive one, or one asked for here.
  const [generated, setGenerated] = useState<ReplyDraftResponse | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<MessageKey | null>(null);
  useEffect(() => {
    setGenerated(null);
    setDraftError(null);
    setDrafting(false);
  }, [id]);
  const draftBody = generated?.body ?? data?.proactiveDraft ?? null;
  const target = data ? replyTarget(data, generated) : null;
  const onDraft = props.onDraft;
  useEffect(() => {
    onDraft?.(draftBody && target ? { body: draftBody, ...target } : null);
  }, [draftBody, target?.to, target?.subject, onDraft]);

  // Opening a mail marks it read (an explicit write; GET stays side-effect free).
  useEffect(() => {
    if (!data || data.isRead) return;
    patchMailRead(qc, id);
    qc.setQueryData<EmailDetailWire>(qk.email(id), (d) => (d ? { ...d, isRead: true } : d));
    void getServices()
      .ep.mail.markRead(id)
      .catch(() => {});
  }, [data?.id, data?.isRead, id, qc]);

  // A new mail takes focus to its subject (screen readers hear where they are).
  useEffect(() => {
    if (data) headingRef.current?.focus({ preventScroll: true });
  }, [data?.id]);

  const generate = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      setGenerated(await getServices().ep.compose.replyDraft(id));
    } catch (err) {
      setDraftError(draftErrorKey(err));
    } finally {
      setDrafting(false);
    }
  };

  const mailTarget: MailTarget | null = data
    ? { id, from: data.from, subject: data.subject, tier }
    : null;
  const reply = (body: string) =>
    target ? { emailId: id, to: target.to, subject: target.subject, body, from: account } : null;

  const actions = [
    {
      key: "reply",
      icon: "reply" as const,
      label: t("reader.action.reply"),
      run: () => {
        const r = reply(draftBody ?? "");
        if (r) props.onReply(r);
      },
    },
    {
      key: "done",
      icon: "done" as const,
      label: t("mail.action.done"),
      run: () => mailTarget && props.onDone(mailTarget),
    },
    {
      key: "lane",
      icon: "lane" as const,
      label: t("reader.action.lane"),
      run: () => mailTarget && props.onLane(mailTarget),
    },
    {
      key: "later",
      icon: "later" as const,
      label: t("reader.action.later"),
      run: () => mailTarget && props.onLater(mailTarget),
    },
  ];
  // Wide windows: the actions sit in the reader's top bar (the floating
  // assistant owns the bottom-right corner); phones and tabletop keep the
  // Reader artboard's bottom toolbar.
  const actionsOnTop = plan.panes === 2;
  // A narrow detail pane (a Fold's half beside the hinge) shows the icons
  // only; the label stays as the accessible name and the tooltip.
  const navWidth = plan.nav === "sidebar" ? SIDEBAR_WIDTH : plan.nav === "rail" ? RAIL_WIDTH : 0;
  const paneWidth = plan.width - navWidth - plan.listWidth - (plan.hinge?.size ?? 1);
  const iconsOnly = actionsOnTop && paneWidth < 600;
  const actionButtons = (className: string) =>
    actions.map((a) => (
      <button
        key={a.key}
        type="button"
        className={className}
        onClick={a.run}
        disabled={!data}
        aria-label={iconsOnly ? a.label : undefined}
        title={iconsOnly ? a.label : undefined}
        data-icon-only={iconsOnly || undefined}
      >
        <MailGlyph name={a.icon} size={actionsOnTop ? 20 : 24} strokeWidth={1.75} />
        {iconsOnly ? null : a.label}
      </button>
    ));

  const nav = (
    <div className="reader-nav">
      {plan.nav === "tabs" && plan.posture !== "tabletop" ? (
        <button type="button" className="reader-nav__back" onClick={props.onBack}>
          <MailGlyph name="chevronLeft" size={24} strokeWidth={2.2} />
          {t("tab.mail")}
        </button>
      ) : null}
      {actionsOnTop ? (
        <div className="reader-nav__actions" role="toolbar" aria-label={t("reader.actions")}>
          {actionButtons("reader-nav__action")}
        </div>
      ) : null}
      <span className="reader-nav__spacer" />
      <button
        type="button"
        className="reader-nav__step"
        aria-label={t("reader.prev")}
        disabled={!newerId}
        onClick={() => newerId && props.onOpen(newerId)}
      >
        <MailGlyph name="chevronUp" size={22} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="reader-nav__step"
        aria-label={t("reader.next")}
        disabled={!olderId}
        onClick={() => olderId && props.onOpen(olderId)}
      >
        <MailGlyph name="chevronDown" size={22} strokeWidth={2} />
      </button>
    </div>
  );

  if (email.isPending && !data) {
    return (
      <div className="reader" aria-busy="true">
        {nav}
        <div className="reader__scroll">
          <div className="reader__body">
            <span className="skeleton skeleton--strong" style={{ width: "86%", height: 22 }} />
            <span className="skeleton skeleton--strong" style={{ width: "54%", height: 22 }} />
            <div className="reader-sender">
              <span className="skeleton skeleton--avatar" />
              <span className="skeleton" style={{ width: "40%" }} />
            </div>
            <span className="skeleton skeleton--block" style={{ height: 72 }} />
            <span className="skeleton" style={{ width: "92%" }} />
            <span className="skeleton" style={{ width: "80%" }} />
          </div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="reader">
        {nav}
        <div className="reader__scroll">
          <ProblemState
            kind={
              email.error && (email.error as { isOffline?: boolean }).isOffline
                ? "offline"
                : "error"
            }
            onRetry={() => void email.refetch()}
          />
        </div>
      </div>
    );
  }

  const label = senderLabel(data.from);
  const { name, org } = splitSender(label);
  const date = new Date(data.date);
  const clock = new Intl.DateTimeFormat(intlTag, {
    ...(date.toDateString() === new Date().toDateString()
      ? {}
      : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const others =
    [data.to, data.cc]
      .filter(Boolean)
      .join(",")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length - 1;
  const accountLabel = labelOf(account);
  const dossierText = dossier.data?.summary?.trim() || null;
  const briefText = brief.data?.whyNow?.trim() || null;
  const attachmentNote = (data.attachments ?? []).find((a) => a.summary);
  const wide = plan.panes === 2 || plan.posture === "tabletop";

  return (
    <div className="reader" data-wide={wide || undefined}>
      {nav}
      <div className="reader__scroll">
        <article className="reader__body" aria-labelledby="reader-subject">
          {wide ? (
            <div className="reader__meta-line">
              {tier ? (
                <span className={`lane-chip lane-chip--reader lane-chip--${tier.toLowerCase()}`}>
                  {tier}
                </span>
              ) : null}
              <span className="reader__meta-text">
                {[accountLabel, clock].filter(Boolean).join(" · ")}
              </span>
            </div>
          ) : null}
          <h1
            id="reader-subject"
            ref={headingRef}
            tabIndex={-1}
            className="reader__subject selectable"
          >
            {data.subject || t("mail.noSubject")}
          </h1>
          <div className="reader-sender">
            <span className={`mail-avatar mail-avatar--${avatarTone(name)}`} aria-hidden="true">
              {monogram(name)}
            </span>
            <span className="reader-sender__text">
              <span className="reader-sender__name">
                {name}
                {org ? <span className="reader-sender__org"> · {org}</span> : null}
              </span>
              <span className="reader-sender__meta">
                {wide ? null : clock}
                {others > 0 ? `${wide ? "" : " · "}${tn("reader.recipients", others)}` : ""}
                {account && !wide ? (
                  <>
                    {" · "}
                    <SourceBadge inbox={account} size={14} />
                    <span className="reader-sender__account">{accountLabel}</span>
                  </>
                ) : null}
              </span>
            </span>
          </div>

          {tier && (tierReason || tier !== "QUEUE") ? (
            <section
              className={`why-card why-card--${tier.toLowerCase()}`}
              aria-label={t("reader.why.label")}
            >
              <span className="why-card__title">
                <span className={`lane-chip lane-chip--why lane-chip--${tier.toLowerCase()}`}>
                  {tier}
                </span>
                {t(WHY_TITLE[tier])}
              </span>
              <p className="why-card__text">{tierReason ?? t("reader.why.none")}</p>
            </section>
          ) : null}

          {dossierText || briefText || attachmentNote ? (
            <section className="reader-context" aria-label={t("reader.context.label")}>
              {dossierText ? <ContextLine icon="people">{dossierText}</ContextLine> : null}
              {briefText ? <ContextLine icon="thread">{briefText}</ContextLine> : null}
              {attachmentNote ? (
                <ContextLine icon="paperclip">
                  {t("reader.context.attachment", {
                    name: attachmentNote.filename,
                    summary: attachmentNote.summary ?? "",
                  })}
                </ContextLine>
              ) : null}
            </section>
          ) : null}

          {data.renderHtml ? (
            <MailFrame emailId={id} html={data.renderHtml} onMailto={props.onMailto} />
          ) : data.body || data.snippet ? (
            <PlainBody text={data.body ?? data.snippet ?? ""} />
          ) : (
            <EmptyState tone="neutral" icon="mail" title={t("reader.empty")} />
          )}

          <Attachments email={data} />

          {props.inlineDraft ? null : draftBody && target ? (
            <section className="draft-card" aria-labelledby="draft-h">
              <div className="draft-card__head">
                <h2 id="draft-h" className="draft-card__title">
                  <MailGlyph name="spark" size={15} />
                  {t("reader.draft.title")}
                </h2>
                <span className="draft-card__hint">{t("reader.draft.hint")}</span>
              </div>
              <p className="draft-card__body selectable">{draftBody}</p>
              <div className="draft-card__actions">
                <button
                  type="button"
                  className="reply-btn reply-btn--quiet"
                  onClick={() => {
                    const r = reply(draftBody);
                    if (r) props.onReply(r);
                  }}
                >
                  {t("reader.draft.edit")}
                </button>
                <button
                  type="button"
                  className="reply-btn reply-btn--primary"
                  onClick={() => {
                    const r = reply(draftBody);
                    if (r) props.onReview(r);
                  }}
                >
                  {t("reader.draft.review")}
                </button>
              </div>
            </section>
          ) : data.needsReply ? (
            <section className="draft-card draft-card--empty" aria-labelledby="draft-h">
              <h2 id="draft-h" className="draft-card__title">
                <MailGlyph name="spark" size={15} />
                {t("reader.draft.title")}
              </h2>
              {draftError ? (
                <p className="reply-form__error" role="alert">
                  <WriteError messageKey={draftError} />
                </p>
              ) : (
                <p className="draft-card__hint">{t("reader.draft.offer")}</p>
              )}
              <div className="draft-card__actions">
                <button
                  type="button"
                  className="reply-btn reply-btn--quiet"
                  onClick={() => {
                    const r = reply("");
                    if (r) props.onReply(r);
                  }}
                >
                  {t("reader.draft.writeOwn")}
                </button>
                <button
                  type="button"
                  className="reply-btn reply-btn--primary"
                  disabled={drafting}
                  aria-busy={drafting || undefined}
                  onClick={() => void generate()}
                >
                  {drafting ? t("reader.draft.drafting") : t("reader.draft.make")}
                </button>
              </div>
            </section>
          ) : null}
        </article>
      </div>
      {actionsOnTop ? null : (
        <nav className="reader-bar" aria-label={t("reader.actions")}>
          {actionButtons("reader-bar__button")}
        </nav>
      )}
    </div>
  );
}
