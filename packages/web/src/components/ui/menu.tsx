"use client";

/**
 * Menu (productization plan §1, P5) — a button that opens a short list of
 * choices or actions: Mail's account facet, its secondary filters and its
 * overflow menu.
 *
 * Semantics: the trigger is a button with aria-haspopup="menu"; the popover is
 * role="menu" holding menuitemradio / menuitemcheckbox / menuitem (a link item
 * is an anchor with role="menuitem"). Opening moves focus to the checked item,
 * or the first. Up/Down move, Home/End jump, Escape closes and returns focus
 * to the trigger, Tab and an outside press close. Every key the menu handles —
 * and any plain character typed while it is open — is `preventDefault`ed, so
 * the app hotkeys never act on a key meant for the menu. Items are 44px tall.
 */

import Link from "next/link";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export interface MenuItem {
  id: string;
  label: string;
  /** Decorative or self-labelled node before the label (a SourceBadge). */
  leading?: ReactNode;
  /** Secondary text after the label ("Needs reconnecting"). */
  hint?: string;
  /** radio / checkbox items show a check mark when `checked`. */
  kind?: "action" | "radio" | "checkbox";
  checked?: boolean;
  disabled?: boolean;
  /** Navigate instead of acting. */
  href?: string;
  onSelect?: () => void;
}

export interface MenuSection {
  id: string;
  /** Visible group heading; also names the group for assistive tech. */
  heading?: string;
  items: ReadonlyArray<MenuItem>;
}

interface MenuProps {
  /** Accessible name of the trigger (and of the menu). */
  label: string;
  /** What the trigger shows. Defaults to `label`. */
  children?: ReactNode;
  sections: ReadonlyArray<MenuSection>;
  /** `chip`: a bordered capsule with a caret. `icon`: a square 44px button. */
  variant?: "chip" | "icon";
  /**
   * Which trigger edge the popover lines up with. `end-from-md` is for a
   * trigger that sits at the right on desktop and at the left on a phone.
   */
  align?: "start" | "end" | "end-from-md";
  /** Marks the chip as holding a non-default choice. */
  active?: boolean;
  disabled?: boolean;
  className?: string;
}

const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])';
const ITEM_CLASS =
  "focus-ring flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-control px-2 text-left text-body text-ink hover:bg-surface-hover focus-visible:bg-surface-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

const ALIGN_CLASS = {
  start: "left-0",
  end: "right-0",
  "end-from-md": "left-0 md:left-auto md:right-0",
} as const;

function Caret() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-ink-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function CheckMark({ shown }: { shown: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`size-4 shrink-0 text-accent-solid ${shown ? "" : "invisible"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

function MenuRow({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const checkable = item.kind === "radio" || item.kind === "checkbox";
  const content = (
    <>
      {checkable && <CheckMark shown={item.checked === true} />}
      {item.leading}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint && <span className="shrink-0 text-caption text-ink-muted">{item.hint}</span>}
    </>
  );
  if (item.href && !item.disabled) {
    return (
      <Link href={item.href} role="menuitem" tabIndex={-1} onClick={onDone} className={ITEM_CLASS}>
        {content}
      </Link>
    );
  }
  const common = {
    type: "button" as const,
    "aria-disabled": item.disabled || undefined,
    tabIndex: -1,
    onClick: () => {
      if (item.disabled) return;
      item.onSelect?.();
      onDone();
    },
    className: ITEM_CLASS,
  };
  const checked = item.checked === true;
  // One literal role per branch, so the role / aria-checked pairing is checkable.
  if (item.kind === "radio") {
    return (
      <button {...common} role="menuitemradio" aria-checked={checked}>
        {content}
      </button>
    );
  }
  if (item.kind === "checkbox") {
    return (
      <button {...common} role="menuitemcheckbox" aria-checked={checked}>
        {content}
      </button>
    );
  }
  return (
    <button {...common} role="menuitem">
      {content}
    </button>
  );
}

export function Menu({
  label,
  children,
  sections,
  variant = "chip",
  align = "start",
  active = false,
  disabled = false,
  className = "",
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []),
    [],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Opening lands on the current choice, so Enter-then-Escape changes nothing.
  useEffect(() => {
    if (!open) return;
    const all = items();
    (all.find((el) => el.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
  }, [open, items]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      // Not prevented: focus goes back to the trigger first, so Tab continues
      // from there instead of from the top of the page once the menu unmounts.
      close(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    const all = items();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = {
      ArrowDown: (at + 1) % all.length,
      ArrowUp: (at - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      all[moves[event.key]]?.focus();
      return;
    }
    // A plain character belongs to the open menu, not to an app hotkey.
    if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
  };

  const triggerClass =
    variant === "icon"
      ? "h-11 w-11 justify-center rounded-control text-ink-mid hover:bg-surface-hover hover:text-ink"
      : "h-11";

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onTriggerKeyDown}
        className={`group/trigger focus-ring flex cursor-pointer items-center transition-colors duration-120 ease-fluid disabled:cursor-not-allowed disabled:opacity-50 ${
          variant === "icon" ? "" : "rounded-full"
        } ${triggerClass}`}
      >
        {variant === "icon" ? (
          children
        ) : (
          <span
            className={`flex h-8 max-w-56 items-center gap-1.5 rounded-full border px-3 text-label transition-colors duration-120 ease-fluid group-hover/trigger:bg-surface-hover ${
              active || open
                ? "border-line-strong bg-surface-panel text-ink"
                : "border-line text-ink-soft"
            }`}
          >
            <span className="flex min-w-0 items-center gap-1.5 truncate">{children ?? label}</span>
            <Caret />
          </span>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={`absolute top-full z-30 mt-1 w-max min-w-56 max-w-[min(20rem,calc(100vw-2rem))] rounded-card border border-line bg-surface-elevated p-1 shadow-l2 ${
            ALIGN_CLASS[align]
          }`}
        >
          {sections.map((section, index) => (
            // biome-ignore lint/a11y/useSemanticElements: a menu's groups are role="group" by the ARIA menu pattern; <fieldset> is for form controls
            <div
              key={section.id}
              role="group"
              aria-label={section.heading}
              className={index > 0 ? "mt-1 border-t border-line-soft pt-1" : undefined}
            >
              {section.heading && (
                <p aria-hidden="true" className="px-2 pb-1 pt-2 text-caption text-ink-muted">
                  {section.heading}
                </p>
              )}
              {section.items.map((item) => (
                <MenuRow key={item.id} item={item} onDone={() => close(true)} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Menu;
