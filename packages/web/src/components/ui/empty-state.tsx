/**
 * EmptyState (productization plan §2, P2) — what a surface shows when there
 * is nothing in it yet. Icon slot, a `text-title` heading, one line of body,
 * and at most one primary action. Write the copy for day one: say what will
 * appear here and, when there is one, the single next step ("Connect an
 * account"), not that something is missing.
 */

import type { ReactNode } from "react";
import Button from "./button";

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  /** Decorative glyph; hidden from assistive tech. */
  icon?: ReactNode;
  title: string;
  /** One line of body copy. */
  description: string;
  /** The single primary action, rendered as the primary Button. */
  primaryAction?: EmptyStateAction;
  /** Custom action node (e.g. a link) when a Button does not fit. */
  action?: ReactNode;
  /** Heading level for the title; defaults to h2. */
  headingLevel?: "h2" | "h3";
  className?: string;
}

export default function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  action,
  headingLevel = "h2",
  className = "",
}: EmptyStateProps) {
  const Heading = headingLevel;
  return (
    <div
      className={`flex flex-col items-center justify-center px-4 py-12 text-center ${className}`}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="mb-4 flex size-12 items-center justify-center rounded-card border border-line bg-surface-raised text-ink-muted"
        >
          {icon}
        </div>
      )}
      <Heading className="text-title text-ink [word-break:keep-all]">{title}</Heading>
      <p className="mt-1 max-w-sm text-body text-ink-muted [word-break:keep-all]">{description}</p>
      {(primaryAction || action) && (
        <div className="mt-6 flex flex-col items-center gap-2">
          {primaryAction && (
            <Button variant="primary" onClick={primaryAction.onClick}>
              {primaryAction.label}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

export { EmptyState };
