/**
 * Sheet — the app's one modal surface (LaneSheet artboard): Mail's lane /
 * account / snooze / confirm / composer panels and the Calendar, Assistant
 * and Accounts sheets. Three shapes:
 *
 *   compact (phones, Flip unfolded, tabletop)  bottom sheet, r28 top corners,
 *                                              grabber, drag down to dismiss
 *   medium / expanded                          centred dialog (r20), same content
 *   variant="side", medium / expanded          full-height side sheet (the
 *                                              expanded layout's assistant)
 *
 * Accessibility: role=dialog + aria-modal, labelled by its title; focus moves
 * in and is trapped (the app root is `inert` while open, with a Tab-wrap
 * fallback); Escape (topmost sheet only), the scrim, the optional close
 * button and Android back (router.registerSheet) close it; focus returns to
 * the opener. Reduced motion → fade only.
 */
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/I18nProvider";
import { useLayout } from "../layout/LayoutContext";
import { useRouter } from "../router/Router";
import { Icon } from "./Icon";
import "./sheet.css";

/** Drag past this (or fling down) to dismiss. */
export const SHEET_DISMISS_DISTANCE = 96;
const SHEET_DISMISS_VELOCITY = 0.5;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FORM_FIELD = "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select";

/** Open sheets, oldest first: Escape closes only the topmost (a stacked confirm). */
const openSheets: symbol[] = [];

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Visually hide the title (it still labels the dialog). */
  hideTitle?: boolean;
  /** A line under the title (the mail the sheet acts on). */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Sticky footer (the primary button). */
  footer?: ReactNode;
  /** Wide layouts: dialog width. */
  width?: number;
  /** Element to focus first (else the first focusable). */
  initialFocus?: () => HTMLElement | null;
  className?: string;
  /** "full" on compact: the composer — fills the screen above the keyboard. */
  size?: "auto" | "full";
  /** Extra CSS variables on the sheet root (e.g. --kb-inset). */
  style?: CSSProperties;
  /** "side": a full-height sheet at the trailing edge on medium / expanded. */
  variant?: "auto" | "side";
  /**
   * A 44px close button in the header. Without it the first control takes
   * focus on open; with it, a `[data-autofocus]` element or the first form
   * field does, else the panel (so focus never lands on the close button).
   */
  closeButton?: boolean;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

export function Sheet(props: SheetProps) {
  const { open } = props;
  // Keep it mounted through the exit transition.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), reducedMotion() ? 0 : 160);
    return () => clearTimeout(t);
  }, [open]);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(<SheetBody {...props} visible={visible && open} />, document.body);
}

function SheetBody({
  open,
  visible,
  onClose,
  title,
  hideTitle,
  subtitle,
  children,
  footer,
  width = 440,
  initialFocus,
  className,
  size = "auto",
  style: extraStyle,
  variant = "auto",
  closeButton = false,
}: SheetProps & { visible: boolean }) {
  const plan = useLayout();
  const { t } = useI18n();
  const { registerSheet } = useRouter();
  const bottom =
    plan.sizeClass === "compact" || plan.sizeClass === "cover" || plan.posture === "tabletop";
  const shape = bottom ? "bottom" : variant === "side" ? "side" : "dialog";
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<{ y: number; t: number; lastY: number; lastT: number } | null>(null);

  // Android back + Escape close the sheet; the app behind is inert.
  useEffect(() => {
    if (!open) return;
    const unregister = registerSheet(() => closeRef.current());
    const self = Symbol("sheet");
    openSheets.push(self);
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");
    const focusFirst = () => {
      const panel = panelRef.current;
      const target =
        initialFocus?.() ??
        panel?.querySelector<HTMLElement>("[data-autofocus]") ??
        (closeButton
          ? panel?.querySelector<HTMLElement>(FORM_FIELD)
          : panel?.querySelector<HTMLElement>(FOCUSABLE)) ??
        panel;
      target?.focus({ preventScroll: true });
    };
    const raf = requestAnimationFrame(focusFirst);
    const onKey = (e: KeyboardEvent) => {
      if (openSheets[openSheets.length - 1] !== self) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      unregister();
      openSheets.splice(openSheets.indexOf(self), 1);
      document.removeEventListener("keydown", onKey);
      // Another sheet may still be open (stacked confirm); only the last one restores.
      if (!document.querySelector(".sheet[data-open='true']:not([data-closing])")) {
        root?.removeAttribute("inert");
        root?.removeAttribute("aria-hidden");
      }
      opener?.focus?.({ preventScroll: true });
    };
    // initialFocus / closeButton are read once, when the sheet opens.
  }, [open, registerSheet]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!bottom) return;
      // A control in the header (the close button) keeps its own tap.
      if ((e.target as Element).closest("button, a, input")) return;
      dragStart.current = { y: e.clientY, t: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [bottom],
  );
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = dragStart.current;
    if (!s) return;
    s.lastY = e.clientY;
    s.lastT = e.timeStamp;
    setDrag(Math.max(0, e.clientY - s.y));
  }, []);
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const s = dragStart.current;
      dragStart.current = null;
      if (!s) return;
      const dy = Math.max(0, e.clientY - s.y);
      const dt = Math.max(1, e.timeStamp - s.t);
      if (dy > SHEET_DISMISS_DISTANCE || (dy > 24 && dy / dt > SHEET_DISMISS_VELOCITY)) {
        setDrag(0);
        onClose();
        return;
      }
      setDrag(0);
    },
    [onClose],
  );

  const style = {
    ...extraStyle,
    "--sheet-drag": `${drag}px`,
    "--sheet-width": `${width}px`,
  } as CSSProperties;

  return (
    <div
      className={`sheet sheet--${shape} sheet--${size} ${className ?? ""}`}
      data-open={visible ? "true" : "false"}
      data-dragging={drag > 0 ? "true" : undefined}
      style={style}
    >
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
      >
        {bottom ? (
          <div
            className="sheet__grab"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            aria-hidden="true"
          >
            <span className="sheet__grabber" />
          </div>
        ) : null}
        <div
          className={`sheet__head${hideTitle ? " sheet__head--hidden" : ""}${closeButton ? " sheet__head--close" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="sheet__titles">
            <h2 id={titleId} className={hideTitle ? "sr-only" : "sheet__title"}>
              {title}
            </h2>
            {subtitle ? (
              <span id={subtitleId} className="sheet__subtitle">
                {subtitle}
              </span>
            ) : null}
          </div>
          {closeButton ? (
            <button type="button" className="sheet__close" onClick={onClose}>
              <Icon name="close" size={20} strokeWidth={2} label={t("settings.ui.close")} />
            </button>
          ) : null}
        </div>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
