/**
 * The States artboard: offline banner, skeleton rows, empty state — plus the
 * error / offline full states a block shows when it has nothing cached.
 */
import type { ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { Icon, type IconName } from "./Icon";
import "./states.css";

export function OfflineBanner() {
  const { t } = useI18n();
  return (
    <div className="offline-banner" role="status">
      <Icon name="offline" size={18} strokeWidth={1.9} className="offline-banner__icon" />
      <span>{t("state.offline.banner")}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = useI18n();
  const widths = [
    ["46%", "82%", "58%"],
    ["38%", "74%", "64%"],
    ["52%", "68%", "44%"],
  ];
  return (
    <div
      className="skeleton-card"
      role="status"
      aria-busy="true"
      aria-label={label ?? t("state.loading")}
    >
      {Array.from({ length: rows }, (_, i) => {
        const w = widths[i % widths.length] ?? ["50%", "70%", "60%"];
        return (
          <div className="skeleton-row" key={`sk-${w[0]}-${i}`}>
            <span className="skeleton skeleton--avatar" />
            <span className="skeleton-row__lines">
              <span className="skeleton skeleton--strong" style={{ width: w[0] }} />
              <span className="skeleton" style={{ width: w[1] }} />
              <span className="skeleton" style={{ width: w[2] }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
  tone?: "ok" | "neutral";
  icon?: IconName;
  className?: string;
}

export function EmptyState({ title, body, action, tone = "ok", icon, className }: EmptyStateProps) {
  return (
    <section className={`empty-state ${className ?? ""}`}>
      <span className={`empty-state__icon empty-state__icon--${tone}`} aria-hidden="true">
        <Icon name={icon ?? (tone === "ok" ? "check" : "spark")} size={28} />
      </span>
      <span className="empty-state__title">{title}</span>
      {body ? <span className="empty-state__body">{body}</span> : null}
      {action}
    </section>
  );
}

export function ProblemState({
  kind,
  onRetry,
  compact = false,
}: {
  kind: "error" | "offline";
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className={`problem-state${compact ? " problem-state--compact" : ""}`} role="alert">
      <span className={`problem-state__icon problem-state__icon--${kind}`} aria-hidden="true">
        <Icon
          name={kind === "offline" ? "offline" : "alert"}
          size={compact ? 20 : 26}
          strokeWidth={1.9}
        />
      </span>
      <span className="problem-state__title">
        {t(kind === "offline" ? "state.offline.title" : "state.error.title")}
      </span>
      {compact ? null : (
        <span className="problem-state__body">
          {t(kind === "offline" ? "state.offline.body" : "state.error.body")}
        </span>
      )}
      {onRetry ? (
        <button type="button" className="button button--quiet" onClick={onRetry}>
          {t("state.retry")}
        </button>
      ) : null}
    </section>
  );
}
