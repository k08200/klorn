"use client";

/**
 * Where the reader's reply box lives (mobile redesign PR4).
 *
 * - From 600px ("inline"): in the reader, under the message, as before.
 * - Below 600px ("sheet"): a bottom sheet that Reply opens. A drag handle, a
 *   44px close, focus trapped, Escape / back closes and focus returns to
 *   Reply. The sheet sits above the on-screen keyboard (visualViewport) and is
 *   allowed nearly the full height, so the draft — whose text box grows with
 *   its text — is shown whole, and the reply box's Send row stays pinned to
 *   the sheet's bottom edge.
 * - On a half-folded screen (two vertical viewport segments: Galaxy Flip /
 *   Fold in flex mode, Surface Duo on its side), at any width ("dock"): the
 *   reader keeps the top segment and the composer takes the bottom one, from
 *   the hinge down, its content starting below the hinge. Non-modal, so the
 *   mail stays readable and scrollable above it; Escape or Close ends it.
 *   Where the posture is folded but no segments are reported there is no
 *   hinge position to split at, so the sheet is used.
 *
 * Closing never drops the draft: the reader page owns it (email-detail-page),
 * the sheet only shows it. The original message is folded under a disclosure.
 */

import { type ReactNode, useEffect, useId, useRef } from "react";
import Button from "../../../../components/ui/button";
import { Sheet } from "../../../../components/ui/sheet";
import { useT } from "../../../../lib/i18n";
import { isPlainEscape, modalStack } from "../../../../lib/modal-stack";
import { useMediaQuery } from "../../../../lib/use-media-query";
import { useVisualViewport } from "../../../../lib/use-visual-viewport";

/** The reply box's own layout: in the reader, or inside the sheet / dock. */
export type ReplyLayout = "inline" | "sheet";
export type ComposerMode = "inline" | "sheet" | "dock";

/** Below the rail step (`max-rail:`, 37.5rem). */
export const PHONE_QUERY = "not all and (min-width: 37.5rem)";
/** Two segments stacked top / bottom: a horizontal hinge. */
export const FOLDED_QUERY = "(vertical-viewport-segments: 2)";

/** Inline until mounted, so the first render matches the server's. */
export function useComposerMode(): ComposerMode {
  const phone = useMediaQuery(PHONE_QUERY);
  const folded = useMediaQuery(FOLDED_QUERY);
  if (folded) return "dock";
  return phone ? "sheet" : "inline";
}

/** The reader keeps its content above the hinge while the dock is up. */
export const DOCKED_READER_PADDING =
  "calc(100dvh - env(viewport-segment-bottom 0 0, 50dvh) + 1rem)";

const SHEET_MAX_HEIGHT = "max(0.5rem, env(safe-area-inset-top))";

function CloseGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function OriginalMessage({ text }: { text: string | null }) {
  const { t } = useT();
  if (!text) return null;
  return (
    <details className="group rounded-control border border-line-soft">
      <summary className="focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-control px-3 text-role-label text-ink-mid hover:text-ink [&::-webkit-details-marker]:hidden">
        {t("mailV2.reply.original")}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-3.5 transition-transform duration-120 ease-fluid group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </summary>
      <pre className="whitespace-pre-wrap break-keep border-t border-line-soft px-3 py-2 font-sans text-role-body leading-6 text-ink-mid [overflow-wrap:anywhere]">
        {text}
      </pre>
    </details>
  );
}

interface ComposerProps {
  mode: Exclude<ComposerMode, "inline">;
  open: boolean;
  onClose: () => void;
  subject: string;
  /** The answered mail as plain text, for the folded quote. */
  original: string | null;
  /** The reader's error (a failed draft or send), shown inside: the page's banner is covered. */
  error: string | null;
  onDismissError: () => void;
  children: ReactNode;
}

function ComposerError({ error, onDismissError }: Pick<ComposerProps, "error" | "onDismissError">) {
  const { t } = useT();
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-control border border-state-danger-line bg-state-danger-bg py-1 pl-3 pr-1 text-role-body text-state-danger-ink"
    >
      <p className="min-w-0 flex-1">{error}</p>
      <Button variant="ghost" size="sm" onClick={onDismissError} className="min-h-11">
        {t("mailV2.dismiss")}
      </Button>
    </div>
  );
}

function ReplySheet({ open, onClose, subject, original, children, ...rest }: ComposerProps) {
  const { t } = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const visible = useVisualViewport(open);
  const maxHeight = visible
    ? `calc(${visible.height}px - ${SHEET_MAX_HEIGHT})`
    : `calc(100dvh - ${SHEET_MAX_HEIGHT})`;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("keys.reply")}
      description={subject}
      closeLabel={t("mailV2.dismiss")}
      handle
      // The draft is read before anything is typed: focus the content, not a
      // field, so the keyboard does not cover it on open.
      initialFocusRef={contentRef}
      panelStyle={{ bottom: visible?.bottomInset ?? 0, maxHeight }}
    >
      <div ref={contentRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        <ComposerError {...rest} />
        <OriginalMessage text={original} />
        {children}
      </div>
    </Sheet>
  );
}

function ReplyDock({ open, onClose, subject, original, children, ...rest }: ComposerProps) {
  const { t } = useT();
  // The keyboard rises inside the bottom segment: keep Send above it.
  const visible = useVisualViewport(open);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = Symbol("reply-dock");
    modalStack.push(token);
    contentRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!modalStack.isTop(token) || !isPlainEscape(event)) return;
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      modalStack.remove(token);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      data-testid="reply-dock"
      // From the hinge's top edge down; the content starts below the hinge.
      style={{
        top: "env(viewport-segment-bottom 0 0, 50dvh)",
        bottom: visible?.bottomInset ?? 0,
        paddingTop:
          "calc(env(viewport-segment-top 0 1, 50dvh) - env(viewport-segment-bottom 0 0, 50dvh))",
      }}
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col bg-surface-elevated text-ink shadow-sheet"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-line-soft py-1 pr-2 pl-5">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-role-title text-ink">
            {t("keys.reply")}
          </h2>
          <p className="truncate text-role-caption text-ink-muted">{subject}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t("mailV2.dismiss")} onClick={onClose}>
          <CloseGlyph />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-role-body">
        <div ref={contentRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
          <ComposerError {...rest} />
          <OriginalMessage text={original} />
          {children}
        </div>
      </div>
    </div>
  );
}

/** Marks the history entry the open composer adds, so Back closes it. */
const BACK_MARK = "klornReplyComposer";

/**
 * True while the open composer's own history entry is the current one. A
 * navigation away from the mail then replaces that entry instead of pushing
 * past it: pushed, it would stay behind the next page, and Back would land on
 * the same mail twice (once on the entry, once on the mail's own).
 */
export function composerEntryOnTop(): boolean {
  return typeof window !== "undefined" && window.history.state?.[BACK_MARK] === true;
}

/**
 * Back (the browser's, Android's) closes the composer instead of leaving the
 * mail: opening adds a history entry for the same URL (the router's own state
 * is kept, so the app router treats Back as a same-page restore); closing any
 * other way takes that entry off again. If something else pushed an entry
 * meanwhile (Back to the list, another mail), the marker is not on top and
 * history is left alone.
 */
function useBackCloses(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ ...window.history.state, [BACK_MARK]: true }, "");
    let popped = false;
    const onPop = () => {
      popped = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped && window.history.state?.[BACK_MARK] === true) window.history.back();
    };
  }, [open]);
}

export function ReplyComposer(props: ComposerProps) {
  useBackCloses(props.open, props.onClose);
  return props.mode === "dock" ? <ReplyDock {...props} /> : <ReplySheet {...props} />;
}
