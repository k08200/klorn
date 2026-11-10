"use client";

/**
 * A Button that is off without being `disabled`: while its request runs
 * (`pending`, with a spinner) or while it cannot act (`unavailable`), it
 * keeps keyboard focus and says so (aria-disabled, aria-busy), and a press
 * does nothing. A `disabled` button drops focus to <body> the moment it is
 * pressed, and a failure then leaves the person nowhere.
 */

import type { MouseEvent, ReactNode } from "react";
import Button from "../../components/ui/button";

interface PendingButtonProps {
  pending?: boolean;
  unavailable?: boolean;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  type?: "button" | "submit";
  form?: string;
  "aria-describedby"?: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function PendingButton({
  pending = false,
  unavailable = false,
  className = "",
  onClick,
  children,
  ...rest
}: PendingButtonProps) {
  const off = pending || unavailable;
  return (
    <Button
      {...rest}
      aria-disabled={off || undefined}
      aria-busy={pending || undefined}
      icon={pending ? <Spinner /> : undefined}
      className={`aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${className}`}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        // A submit button would still submit its form: stop that too.
        if (off) {
          event.preventDefault();
          return;
        }
        onClick?.();
      }}
    >
      {children}
    </Button>
  );
}
