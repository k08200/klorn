/**
 * Writing mail: the reply draft (Reader / FoldTabletop artboards), a new mail,
 * and the confirm sheet in front of every send.
 *
 * Deterministic floor: sending is one of the three real-world actions, so it
 * only ever happens from ConfirmSendSheet, on an explicit tap, with exactly
 * the recipient / subject / body shown there. A new mail leaves from the
 * account picked in the composer ("보내는 계정", POST /api/email/send
 * `linkedInboxAccountId`); a reply from the mail's own account. After the send
 * the sheet turns into the receipt: what went out, and the payload hash
 * (sendEmailPayloadHash). With MANUAL_SEND_RECEIPTS_ENABLED on the server
 * answers with its own ActionReceipt (id + payloadHash, written before the
 * provider was called) and the sheet shows that; otherwise it shows the hash
 * this device computed from the confirmed bytes, and says so.
 */
import type { InboxOption } from "@klorn/contract";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import type { ReplyDraftResponse, SendMailResponse } from "../../api/wire";
import { getServices } from "../../app/services";
import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { hapticSuccess, hapticWarning } from "../../platform/haptics";
import { useKeyboardInset } from "../../platform/keyboard";
import { MailGlyph } from "../../ui/MailGlyph";
import { PlansLink } from "../../ui/PlansLink";
import { Sheet } from "../../ui/Sheet";
import { SourceBadge } from "../../ui/SourceBadge";
import {
  addressOf,
  draftErrorKey,
  PRO_REFUSAL_KEY,
  parseRecipients,
  replySubject,
  sendAccountId,
  sendFailure,
  sendPayloadHash,
} from "./model";
import { useAccountLabel } from "./useAccountLabel";

/** Tone chips → the reply-draft route's `intent` (it regenerates with instructions). */
export const TONES = [
  {
    key: "shorter",
    label: "reader.tone.shorter",
    intent: "Rewrite the reply shorter: two sentences at most.",
  },
  {
    key: "politer",
    label: "reader.tone.politer",
    intent: "Rewrite the reply more polite and formal, keeping the same content.",
  },
  {
    key: "english",
    label: "reader.tone.english",
    intent: "Write the reply in English, keeping the same content.",
  },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey; intent: string }>;

export interface OutgoingMail {
  kind: "reply" | "new";
  /** The mail being answered (reply only). */
  emailId?: string;
  to: string;
  subject: string;
  body: string;
  /** The account it goes out from, as far as the app can name it. */
  from: InboxOption | null;
}

/** A draft / send error line; the plan refusal also carries the way to Pro. */
export function WriteError({ messageKey }: { messageKey: MessageKey }) {
  const { t } = useI18n();
  return (
    <>
      {t(messageKey)}
      {messageKey === PRO_REFUSAL_KEY ? (
        <>
          {" "}
          <PlansLink />
        </>
      ) : null}
    </>
  );
}

// ── Reply form (inline in tabletop, inside the composer sheet elsewhere) ─────

export function ReplyForm({
  emailId,
  initial,
  replyTo,
  subject,
  onReview,
  onSaved,
  layout,
}: {
  emailId: string;
  initial: string;
  replyTo: string;
  subject: string;
  onReview: (body: string) => void;
  onSaved?: () => void;
  layout: "sheet" | "panel";
}) {
  const { t } = useI18n();
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const fieldId = useId();
  useEffect(() => setBody(initial), [initial]);

  const regenerate = async (tone: (typeof TONES)[number]) => {
    setBusy(tone.key);
    setError(null);
    try {
      const draft: ReplyDraftResponse = await getServices().ep.compose.replyDraft(
        emailId,
        tone.intent,
      );
      setBody(draft.body);
    } catch (err) {
      setError(draftErrorKey(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      await getServices().ep.compose.saveReplyDraft(emailId, { to: replyTo, subject, body });
      setSaved(true);
      hapticSuccess();
      onSaved?.();
    } catch {
      setError("reader.draft.saveFailed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`reply-form reply-form--${layout}`}>
      {layout === "panel" ? (
        <div className="reply-form__head">
          <h2 className="reply-form__title">{t("reader.draft.panelTitle")}</h2>
          <span className="reply-form__meta">{t("reader.draft.voice")}</span>
        </div>
      ) : null}
      <label className="reply-form__field" htmlFor={fieldId}>
        <span className="sr-only">{t("reader.draft.bodyLabel")}</span>
        <textarea
          id={fieldId}
          className="reply-form__textarea"
          value={body}
          rows={layout === "panel" ? 4 : 8}
          onChange={(e) => {
            setBody(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <div className="tone-chips" role="group" aria-label={t("reader.tone.label")}>
        {TONES.map((tone) => (
          <button
            key={tone.key}
            type="button"
            className="tone-chip"
            disabled={busy !== null}
            aria-busy={busy === tone.key || undefined}
            onClick={() => void regenerate(tone)}
          >
            {busy === tone.key ? t("reader.tone.working") : t(tone.label)}
          </button>
        ))}
      </div>
      {error ? (
        <p className="reply-form__error" role="alert">
          <WriteError messageKey={error} />
        </p>
      ) : null}
      {saved ? (
        <p className="reply-form__ok" role="status">
          {t("reader.draft.saved")}
        </p>
      ) : null}
      <div className="reply-form__actions">
        <button
          type="button"
          className="reply-btn reply-btn--quiet"
          disabled={busy !== null || !body.trim()}
          onClick={() => void save()}
        >
          {t("reader.draft.save")}
        </button>
        <button
          type="button"
          className="reply-btn reply-btn--primary"
          disabled={busy !== null || !body.trim()}
          onClick={() => onReview(body)}
        >
          {t("reader.draft.review")}
        </button>
      </div>
    </div>
  );
}

// ── Composer sheet (reply edit / new mail) ──────────────────────────────────

export type ComposerMode =
  | {
      kind: "reply";
      emailId: string;
      to: string;
      subject: string;
      body: string;
      from: InboxOption | null;
    }
  | { kind: "new"; to: string; subject?: string; body?: string; from: InboxOption | null };

const accountKey = (inbox: InboxOption | null) => inbox?.id ?? "primary";

export function ComposerSheet({
  open,
  mode,
  accounts,
  onClose,
  onReview,
}: {
  open: boolean;
  mode: ComposerMode | null;
  /** The accounts a new mail can leave from (model.ts sendableAccounts). */
  accounts: readonly InboxOption[];
  onClose: () => void;
  onReview: (mail: OutgoingMail) => void;
}) {
  const { t } = useI18n();
  const inset = useKeyboardInset();
  const accountLabel = useAccountLabel(accounts);
  const toId = useId();
  const subjectId = useId();
  const bodyId = useId();
  const fromId = useId();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [from, setFrom] = useState<InboxOption | null>(null);
  const [touched, setTouched] = useState(false);
  const modeKey = mode ? `${mode.kind}:${"emailId" in mode ? mode.emailId : mode.to}` : "";

  useEffect(() => {
    if (!mode) return;
    setTo(mode.to);
    setSubject(mode.subject ?? "");
    setBody(mode.body ?? "");
    setFrom(
      mode.kind === "reply"
        ? mode.from
        : (accounts.find((a) => accountKey(a) === accountKey(mode.from)) ?? accounts[0] ?? null),
    );
    setTouched(false);
  }, [modeKey]);
  const pickAccount = mode?.kind === "new" && accounts.length > 1;

  const recipients = parseRecipients(to);
  const valid = recipients !== null && subject.trim() !== "" && body.trim() !== "";
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [rewriteError, setRewriteError] = useState<MessageKey | null>(null);
  const rewrite = async (tone: (typeof TONES)[number]) => {
    if (mode?.kind !== "reply") return;
    setRewriting(tone.key);
    setRewriteError(null);
    try {
      const draft = await getServices().ep.compose.replyDraft(mode.emailId, tone.intent);
      setBody(draft.body);
    } catch (err) {
      setRewriteError(draftErrorKey(err));
    } finally {
      setRewriting(null);
    }
  };

  const style = { "--kb-inset": `${inset}px` } as CSSProperties;
  return (
    <Sheet
      style={style}
      open={open && mode !== null}
      onClose={onClose}
      size="full"
      width={640}
      title={mode?.kind === "reply" ? t("reader.compose.replyTitle") : t("mail.compose.title")}
      initialFocus={() => document.getElementById(mode?.kind === "reply" ? bodyId : toId)}
      footer={
        <button
          type="button"
          className="sheet-cta"
          disabled={!valid}
          onClick={() => {
            setTouched(true);
            if (!valid || !mode) return;
            onReview(
              mode.kind === "reply"
                ? { kind: "reply", emailId: mode.emailId, to, subject, body, from: mode.from }
                : {
                    kind: "new",
                    to: (recipients ?? []).join(", "),
                    subject: subject.trim(),
                    body,
                    from,
                  },
            );
          }}
        >
          {t("reader.draft.review")}
        </button>
      }
    >
      <div className="composer">
        <div className="composer__row">
          <label className="composer__label" htmlFor={toId}>
            {t("mail.compose.to")}
          </label>
          <input
            id={toId}
            className="composer__input"
            type="email"
            inputMode="email"
            autoComplete="email"
            multiple
            value={to}
            readOnly={mode?.kind === "reply"}
            aria-invalid={touched && recipients === null ? true : undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="composer__row">
          <label className="composer__label" htmlFor={subjectId}>
            {t("mail.compose.subject")}
          </label>
          <input
            id={subjectId}
            className="composer__input"
            value={subject}
            readOnly={mode?.kind === "reply"}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        {pickAccount ? (
          <div className="composer__row">
            <label className="composer__label" htmlFor={fromId}>
              {t("mail.compose.from")}
            </label>
            {from ? <SourceBadge inbox={from} size={16} /> : null}
            <select
              id={fromId}
              className="composer__input composer__select"
              value={accountKey(from)}
              onChange={(e) =>
                setFrom(accounts.find((a) => accountKey(a) === e.target.value) ?? null)
              }
            >
              {accounts.map((a) => {
                const address = a.email ?? t("mail.account.primary");
                const label = accountLabel(a);
                return (
                  <option key={accountKey(a)} value={accountKey(a)}>
                    {label && label !== address ? `${label} · ${address}` : address}
                  </option>
                );
              })}
            </select>
          </div>
        ) : from ? (
          <div className="composer__row composer__row--static">
            <span className="composer__label">{t("mail.compose.from")}</span>
            <span className="composer__from">
              <SourceBadge inbox={from} size={16} />
              {from.email ?? t("mail.account.primary")}
            </span>
          </div>
        ) : null}
        <label className="sr-only" htmlFor={bodyId}>
          {mode?.kind === "reply" ? t("reader.draft.bodyLabel") : t("reader.confirm.body")}
        </label>
        <textarea
          id={bodyId}
          className="composer__body"
          value={body}
          placeholder={t("mail.compose.bodyPlaceholder")}
          onChange={(e) => setBody(e.target.value)}
        />
        {mode?.kind === "reply" ? (
          <div className="tone-chips" role="group" aria-label={t("reader.tone.label")}>
            {TONES.map((tone) => (
              <button
                key={tone.key}
                type="button"
                className="tone-chip"
                disabled={rewriting !== null}
                aria-busy={rewriting === tone.key || undefined}
                onClick={() => void rewrite(tone)}
              >
                {rewriting === tone.key ? t("reader.tone.working") : t(tone.label)}
              </button>
            ))}
          </div>
        ) : null}
        {rewriteError ? (
          <p className="reply-form__error" role="alert">
            <WriteError messageKey={rewriteError} />
          </p>
        ) : null}
        {touched && recipients === null ? (
          <p className="reply-form__error" role="alert">
            {t("mail.compose.badRecipient")}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

// ── Confirm + receipt ───────────────────────────────────────────────────────

type SendState =
  | { kind: "confirm" }
  | { kind: "sending" }
  | { kind: "sent"; hash: string; result: SendMailResponse; at: Date }
  | { kind: "failed"; message: MessageKey; unknown: boolean };

export function ConfirmSendSheet({
  mail,
  onClose,
  onEdit,
  onSent,
}: {
  mail: OutgoingMail | null;
  onClose: () => void;
  onEdit: () => void;
  onSent: (mail: OutgoingMail) => void;
}) {
  const { t, intlTag } = useI18n();
  const [state, setState] = useState<SendState>({ kind: "confirm" });
  const sending = useRef(false);
  useEffect(() => {
    if (mail) setState({ kind: "confirm" });
  }, [mail]);

  const send = async () => {
    if (!mail || sending.current) return;
    sending.current = true;
    setState({ kind: "sending" });
    // Hash exactly what was shown, before anything leaves.
    const hash = await sendPayloadHash({ to: mail.to, subject: mail.subject, body: mail.body });
    try {
      const { ep } = getServices();
      const result =
        mail.kind === "reply" && mail.emailId
          ? await ep.compose.sendReply(mail.emailId, mail.body)
          : await ep.compose.send({
              to: mail.to,
              subject: mail.subject,
              body: mail.body,
              linkedInboxAccountId: sendAccountId(mail.from),
            });
      hapticSuccess();
      setState({ kind: "sent", hash, result, at: new Date() });
      onSent(mail);
    } catch (err) {
      hapticWarning();
      const failure = sendFailure(err, { kind: mail.kind, accountId: sendAccountId(mail.from) });
      setState({ kind: "failed", ...failure });
    } finally {
      sending.current = false;
    }
  };

  const sent = state.kind === "sent" ? state : null;
  const mismatch =
    sent &&
    mail &&
    sent.result.to &&
    sent.result.to.toLowerCase() !== addressOf(mail.to).toLowerCase();

  return (
    <Sheet
      open={mail !== null}
      onClose={state.kind === "sending" ? () => {} : onClose}
      title={sent ? t("reader.receipt.title") : t("reader.confirm.title")}
      subtitle={sent ? undefined : t("reader.confirm.subtitle")}
      width={520}
      footer={
        sent ? (
          <button type="button" className="sheet-cta" onClick={onClose}>
            {t("reader.receipt.close")}
          </button>
        ) : (
          <>
            {state.kind === "failed" ? (
              <p className="reply-form__error" role="alert">
                <WriteError messageKey={state.message} />
              </p>
            ) : null}
            <button
              type="button"
              className="sheet-cta"
              disabled={state.kind === "sending" || (state.kind === "failed" && state.unknown)}
              onClick={() => void send()}
            >
              <MailGlyph name="send" size={18} />
              {state.kind === "sending" ? t("reader.confirm.sending") : t("reader.confirm.send")}
            </button>
            <button
              type="button"
              className="sheet-cta sheet-cta--quiet"
              disabled={state.kind === "sending"}
              onClick={onEdit}
            >
              {t("reader.confirm.edit")}
            </button>
          </>
        )
      }
    >
      {mail ? (
        <dl className="send-review" data-sent={sent ? "true" : undefined}>
          {sent ? (
            <div className="send-review__ok" role="status">
              <MailGlyph name="done" size={22} strokeWidth={2.2} />
              {t("reader.receipt.sent", {
                time: new Intl.DateTimeFormat(intlTag, {
                  hour: "numeric",
                  minute: "2-digit",
                }).format(sent.at),
              })}
            </div>
          ) : null}
          {mail.from ? (
            <div className="send-review__row">
              <dt>{t("mail.compose.from")}</dt>
              <dd className="send-review__from">
                <SourceBadge inbox={mail.from} size={16} />
                {mail.from.email ?? t("mail.account.primary")}
              </dd>
            </div>
          ) : null}
          <div className="send-review__row">
            <dt>{t("mail.compose.to")}</dt>
            <dd className="selectable">{sent?.result.to ?? mail.to}</dd>
          </div>
          <div className="send-review__row">
            <dt>{t("mail.compose.subject")}</dt>
            <dd className="selectable">{mail.subject}</dd>
          </div>
          <div className="send-review__row send-review__row--body">
            <dt>{t("reader.confirm.body")}</dt>
            <dd className="send-review__body selectable">{mail.body}</dd>
          </div>
          {sent ? <ReceiptRow hash={sent.hash} result={sent.result} /> : null}
          {mismatch ? (
            <p className="reply-form__error" role="alert">
              {t("reader.receipt.mismatch")}
            </p>
          ) : null}
        </dl>
      ) : null}
    </Sheet>
  );
}

/**
 * The receipt line: the server's ActionReceipt when it sent one (id +
 * payloadHash of the bytes the provider received), else the hash this device
 * computed from the confirmed bytes — labelled as such either way.
 */
function ReceiptRow({ hash, result }: { hash: string; result: SendMailResponse }) {
  const { t } = useI18n();
  const server = result.receipt ?? null;
  const shown = server?.payloadHash ?? hash;
  return (
    <div className="send-review__row">
      <dt>{t("reader.receipt.label")}</dt>
      <dd className="send-review__receipt">
        <span className="send-review__hash selectable" title={shown}>
          {t("reader.receipt.hash", { hash: shown.slice(0, 12) })}
        </span>
        {server ? (
          <span className="send-review__hash selectable">
            {t("reader.receipt.id", { id: server.id })}
          </span>
        ) : null}
        <span className="send-review__source">
          {t(server ? "reader.receipt.source.server" : "reader.receipt.source.device")}
        </span>
        {server && server.payloadHash !== hash ? (
          <span className="reply-form__error" role="alert">
            {t("reader.receipt.hashDiffers", { hash: hash.slice(0, 12) })}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

export function replyTarget(
  email: { from: string; subject: string },
  draft?: ReplyDraftResponse | null,
) {
  return {
    to: draft?.to ?? addressOf(email.from),
    subject: draft?.subject ?? replySubject(email.subject),
  };
}
