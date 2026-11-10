/**
 * The app's one toast (canvas: "5초 실행 취소"): a line of text, an optional
 * action (Undo, Retry) and an optional close button, announced politely —
 * assertively for an error (role=alert). Two hosts render it:
 *
 *   - Mail, inside `.mail-screen`: the Done / lane-move undo window (owned by
 *     the undo queue, so it stays exactly as long as the undo is possible),
 *     sitting above the tab bar / reader toolbar;
 *   - StatusNoteHost (ui/StatusNote.tsx), `fixed` on the page: `notify()`
 *     notes from any screen ("Sent — the receipt is in Activity"), with a tone
 *     icon, hiding on their own.
 *
 * Same shape, colours, type and 44px targets everywhere.
 */
import { useI18n } from "../i18n/I18nProvider";
import { Icon } from "./Icon";
import { MailGlyph } from "./MailGlyph";
import "./snackbar.css";

export interface SnackbarProps {
  message: string | null;
  /** Shown as the action button when set. */
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  /** "error": a refusal the user must see (role=alert). */
  tone?: "neutral" | "error";
  /** A leading icon: "ok" (done) or "info". An error always leads with the alert icon. */
  icon?: "ok" | "info";
  /** Fixed to the viewport (the app-wide host) instead of the enclosing screen. */
  fixed?: boolean;
}

export function Snackbar({
  message,
  actionLabel,
  onAction,
  onClose,
  tone = "neutral",
  icon,
  fixed = false,
}: SnackbarProps) {
  const { t } = useI18n();
  const glyph =
    tone === "error" ? "alert" : icon === "ok" ? "check" : icon === "info" ? "info" : null;
  return (
    <div
      className={fixed ? "snackbar-region snackbar-region--fixed" : "snackbar-region"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {message ? (
        <div
          className={`snackbar snackbar--${tone}`}
          role={tone === "error" ? "alert" : "status"}
          data-icon={glyph && tone !== "error" ? icon : undefined}
        >
          {glyph ? (
            <Icon name={glyph} size={18} strokeWidth={2} className="snackbar__icon" />
          ) : null}
          <span className="snackbar__text">{message}</span>
          {actionLabel && onAction ? (
            <button type="button" className="snackbar__action" onClick={onAction}>
              {actionLabel}
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className="snackbar__close"
              onClick={onClose}
              aria-label={t("mail.snackbar.close")}
            >
              <MailGlyph name="close" size={18} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
