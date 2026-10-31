"use client";

/**
 * Listbox — a full-width select with grouped, rich options (the playground's
 * model picker: id, a badge, a price). Menu is for actions and short choices
 * in a compact chip; this is a form field.
 *
 * Semantics follow the ARIA select-only combobox-free listbox pattern: the
 * trigger is a button with aria-haspopup="listbox"; the popup is
 * role="listbox" holding role="group" sections of role="option" rows with
 * aria-selected. Opening focuses the selected option (or the first). Up/Down
 * move, Home/End jump, Enter/Space choose, Escape closes and returns focus to
 * the trigger, Tab and an outside press close. Handled keys are
 * preventDefault-ed so app hotkeys never see them. Trigger and rows are 44px.
 */

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export interface ListboxOption {
  id: string;
  label: string;
  /** Short emphasised tag after the label ("Klorn uses this"). */
  badge?: string;
  /** Secondary text at the end of the row (a price). */
  hint?: string;
  /** Render the label in the mono face (ids, codes). */
  mono?: boolean;
}

export interface ListboxSection {
  id: string;
  heading?: string;
  options: ReadonlyArray<ListboxOption>;
}

interface ListboxProps {
  /** Accessible name of the trigger and the list. */
  label: string;
  /** id of a visible label element, when there is one. */
  labelledBy?: string;
  sections: ReadonlyArray<ListboxSection>;
  value: string | null;
  onChange: (id: string) => void;
  /** What the closed trigger shows. */
  children: ReactNode;
  /** Note rendered at the bottom of the open list (not an option). */
  footer?: ReactNode;
  disabled?: boolean;
  className?: string;
}

const OPTION_SELECTOR = '[role="option"]';

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`size-4 shrink-0 text-ink-muted transition-transform duration-120 ease-fluid ${open ? "rotate-180" : ""}`}
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

function OptionRow({
  option,
  selected,
  onChoose,
}: {
  option: ListboxOption;
  selected: boolean;
  onChoose: (id: string) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onChoose(option.id);
  };
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-option-id={option.id}
      onClick={() => onChoose(option.id)}
      onKeyDown={onKeyDown}
      className={`focus-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-2.5 text-label hover:bg-surface-hover focus-visible:bg-surface-hover ${
        selected ? "bg-surface-hover" : ""
      }`}
    >
      <span
        className={`min-w-0 flex-1 truncate text-ink ${option.mono ? "font-mono" : "font-medium"}`}
      >
        {option.label}
      </span>
      {option.badge && (
        <span className="shrink-0 rounded-control bg-state-info-bg px-1.5 py-0.5 text-caption font-medium text-accent-deeper">
          {option.badge}
        </span>
      )}
      {option.hint && (
        <span className="shrink-0 font-mono text-caption tabular-nums text-ink-mid">
          {option.hint}
        </span>
      )}
    </div>
  );
}

export function Listbox({
  label,
  labelledBy,
  sections,
  value,
  onChange,
  children,
  footer,
  disabled = false,
  className = "",
}: ListboxProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const triggerId = useId();

  const options = useCallback(
    () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? []),
    [],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    (id: string) => {
      onChange(id);
      close(true);
    },
    [onChange, close],
  );

  useEffect(() => {
    if (!open) return;
    const all = options();
    const selected = all.find((el) => el.getAttribute("aria-selected") === "true");
    (selected ?? all[0])?.focus();
    selected?.scrollIntoView({ block: "nearest" });
  }, [open, options]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    const all = options();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = {
      ArrowDown: Math.min(at + 1, all.length - 1),
      ArrowUp: Math.max(at - 1, 0),
      Home: 0,
      End: all.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      all[moves[event.key]]?.focus();
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={labelledBy ? undefined : label}
        // The visible label, then the button's own content: the chosen value.
        aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onTriggerKeyDown}
        className="focus-ring flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-card border border-line-strong bg-surface-panel px-3 text-left transition-colors duration-120 ease-fluid hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">{children}</span>
        <Caret open={open} />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 flex max-h-[min(30rem,70dvh)] flex-col overflow-hidden rounded-card border border-line bg-surface-elevated shadow-l2">
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            onKeyDown={onListKeyDown}
            className="min-h-0 overflow-y-auto overscroll-contain p-1"
          >
            {sections.map((section, index) => (
              <SectionBlock
                key={section.id}
                section={section}
                first={index === 0}
                value={value}
                onChoose={choose}
              />
            ))}
          </div>
          {/* Outside role="listbox": a listbox may only own options and groups. */}
          {footer && (
            <div className="border-t border-line-soft px-3.5 py-2 text-caption text-ink-mid">
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionBlock({
  section,
  first,
  value,
  onChoose,
}: {
  section: ListboxSection;
  first: boolean;
  value: string | null;
  onChoose: (id: string) => void;
}) {
  const divider = first ? undefined : "mt-1 border-t border-line-soft pt-1";
  const rows = section.options.map((option) => (
    <OptionRow key={option.id} option={option} selected={option.id === value} onChoose={onChoose} />
  ));
  // A group needs a name; an unheaded section is just options.
  if (!section.heading) {
    return (
      <div role="presentation" className={divider}>
        {rows}
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="group" is the ARIA listbox grouping; <fieldset> is for form controls
    <div role="group" aria-label={section.heading} className={divider}>
      <p aria-hidden="true" className="px-2.5 pb-1 pt-2 text-caption font-semibold text-ink-mid">
        {section.heading}
      </p>
      {rows}
    </div>
  );
}

export default Listbox;
