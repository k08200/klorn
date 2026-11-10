/**
 * One mail row. Two looks from the artboards:
 *   inset  (Mail, phones)            grouped inset list: unread dot, 40px
 *                                    monogram, account badge, lane label + reason
 *   card   (FoldOpen / TabletLandscape) a card per row with a lane chip; the
 *                                    selected mail is outlined
 * The row is a real link (/mail/:id) wrapped in a SwipeRow; in multi-select a
 * tap toggles instead. A screen-reader / keyboard "actions" button follows
 * every row, because swipes are not discoverable without sight.
 */
import type { EmailListItem, InboxOption } from "@klorn/contract";
import type { MouseEvent } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { useLinkProps } from "../../router/Router";
import type { LaneParam } from "../../router/routes";
import { MailGlyph } from "../../ui/MailGlyph";
import { SourceBadge } from "../../ui/SourceBadge";
import { avatarTone, monogram, rowTimeKind, senderLabel, splitSender } from "./model";
import { SwipeRow } from "./SwipeRow";

export interface MailRowProps {
  email: EmailListItem;
  account: InboxOption | null;
  /** The account's short name ("회사", "개인 Gmail") for the badge's label. */
  accountLabel: string | null;
  reason: string | null;
  lane?: LaneParam;
  variant: "inset" | "card";
  selected: boolean;
  selecting: boolean;
  checked: boolean;
  now: Date;
  onDone: () => void;
  onLane: () => void;
  onLongPress: () => void;
  onToggle: () => void;
  onActions: () => void;
}

/**
 * The row's time. Inset rows sit under a day heading, so they always show a
 * clock (today "8:42", earlier days "오후 6:20"); cards have no headings, so
 * they say "어제" / the weekday / the date (FoldOpen, TabletLandscape).
 */
export function rowTime(
  date: Date,
  now: Date,
  variant: "inset" | "card",
  intlTag: string,
  yesterday: string,
): string {
  const kind = rowTimeKind(date, now);
  const english = intlTag.startsWith("en");
  if (kind === "clock") {
    return new Intl.DateTimeFormat(intlTag, {
      hour: "numeric",
      minute: "2-digit",
      hourCycle: english ? "h12" : "h23",
    }).format(date);
  }
  if (variant === "inset") {
    return new Intl.DateTimeFormat(intlTag, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return yesterday;
  if (kind === "weekday")
    return new Intl.DateTimeFormat(intlTag, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(intlTag, { month: "numeric", day: "numeric" }).format(date);
}

export function MailRow(props: MailRowProps) {
  const { email, account, accountLabel, reason, lane, variant, selected, selecting, checked, now } =
    props;
  const { t, intlTag } = useI18n();
  const link = useLinkProps(
    lane ? { name: "mail", lane, id: email.id } : { name: "mail", id: email.id },
  );
  const label = senderLabel(email.from);
  const { name } = splitSender(label);
  const unread = !email.isRead;
  const date = new Date(email.date);
  const time = rowTime(date, now, variant, intlTag, t("mail.day.yesterday"));
  const subject = email.subject || t("mail.noSubject");
  const a11yLabel = [
    unread ? t("mail.row.unread") : null,
    label,
    subject,
    email.tier ?? null,
    reason,
    time,
    accountLabel,
  ]
    .filter(Boolean)
    .join(", ");

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (selecting) {
      e.preventDefault();
      props.onToggle();
      return;
    }
    link.onClick(e);
  };

  const body =
    variant === "inset" ? (
      <a
        className="mail-row"
        draggable={false}
        href={link.href}
        onClick={onClick}
        aria-current={selected ? "true" : undefined}
        aria-label={a11yLabel}
        data-unread={unread || undefined}
        data-checked={checked || undefined}
      >
        <span className="mail-row__dot-col" aria-hidden="true">
          {selecting ? (
            <MailGlyph
              name={checked ? "select" : "circle"}
              size={22}
              className="mail-row__check"
              fill={checked ? "var(--select-check)" : "none"}
            />
          ) : (
            <span className="mail-row__dot" />
          )}
        </span>
        <span className={`mail-avatar mail-avatar--${avatarTone(name)}`} aria-hidden="true">
          {monogram(name)}
        </span>
        <span className="mail-row__text">
          <span className="mail-row__top">
            <span className="mail-row__from">{label}</span>
            {account ? (
              <SourceBadge inbox={account} size={16} title={accountLabel ?? undefined} />
            ) : null}
            <span className="mail-row__time">{time}</span>
          </span>
          <span className="mail-row__subject">{subject}</span>
          {email.tier || reason ? (
            <span className="mail-row__meta">
              {email.tier ? (
                <span className={`mail-row__lane lane-ink--${email.tier.toLowerCase()}`}>
                  {email.tier}
                </span>
              ) : null}
              {email.tier && reason ? <span className="mail-row__sep" aria-hidden="true" /> : null}
              {reason ? <span className="mail-row__reason">{reason}</span> : null}
            </span>
          ) : null}
        </span>
      </a>
    ) : (
      <a
        className="mail-card"
        draggable={false}
        href={link.href}
        onClick={onClick}
        aria-current={selected ? "true" : undefined}
        aria-label={a11yLabel}
        data-unread={unread || undefined}
        data-checked={checked || undefined}
      >
        <span className="mail-card__top">
          {selecting ? (
            <MailGlyph
              name={checked ? "select" : "circle"}
              size={20}
              className="mail-row__check"
              fill={checked ? "var(--select-check)" : "none"}
            />
          ) : unread ? (
            <span className="mail-card__dot" aria-hidden="true" />
          ) : null}
          <span className="mail-card__from">{label}</span>
          {account ? (
            <SourceBadge inbox={account} size={16} title={accountLabel ?? undefined} />
          ) : null}
          <span className="mail-card__time">{time}</span>
        </span>
        <span className="mail-card__subject">{subject}</span>
        {email.tier || reason ? (
          <span className="mail-card__meta">
            {email.tier ? (
              <span className={`lane-chip lane-chip--card lane-chip--${email.tier.toLowerCase()}`}>
                {email.tier}
              </span>
            ) : null}
            {reason ? <span className="mail-card__reason">{reason}</span> : null}
          </span>
        ) : null}
      </a>
    );

  return (
    <li className={`mail-item mail-item--${variant}`}>
      <SwipeRow
        onDone={props.onDone}
        onLane={props.onLane}
        onLongPress={props.onLongPress}
        disabled={selecting}
      >
        {body}
      </SwipeRow>
      {selecting ? null : (
        <button
          type="button"
          className="mail-item__actions"
          onClick={props.onActions}
          aria-label={t("mail.row.actions", { subject })}
        >
          <MailGlyph name="more" size={20} />
        </button>
      )}
    </li>
  );
}
