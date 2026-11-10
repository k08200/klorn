/**
 * A list row that can be swiped (Mail artboard: the 한끼배달 row mid-swipe).
 * Pointer Events, so touch and a mouse / trackpad drag behave the same.
 * `touch-action: pan-y` leaves vertical scrolling (and pull-to-refresh) to
 * the browser; the row only claims a drag once it is clearly horizontal.
 *
 *   right past 88px (or a fling) → onDone      green "처리 완료" underlay
 *   left  past 88px (or a fling) → onLane      "레인 옮기기" underlay
 *   hold 450ms without moving    → onLongPress (multi-select)
 *
 * A light haptic marks each threshold crossing. Reduced motion: no slide-out
 * animation, the row just goes. Gestures are not discoverable to screen
 * readers, so every action also exists as a button (row menu, reader toolbar).
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { hapticLight, hapticSelection } from "../../platform/haptics";
import { MailGlyph } from "../../ui/MailGlyph";
import {
  armedAction,
  COMMIT_DISTANCE,
  crossedThreshold,
  LONG_PRESS_MS,
  rowOffset,
  swipeIntent,
  swipeOutcome,
  VelocityTracker,
} from "./swipe";

interface SwipeRowProps {
  children: ReactNode;
  onDone: () => void;
  onLane: () => void;
  onLongPress: () => void;
  /** Multi-select is on: no swiping, taps select. */
  disabled?: boolean;
  className?: string;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function SwipeRow({
  children,
  onDone,
  onLane,
  onLongPress,
  disabled,
  className,
}: SwipeRowProps) {
  const { t } = useI18n();
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<"right" | null>(null);
  const [settling, setSettling] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const intent = useRef<"pending" | "horizontal" | "vertical">("pending");
  const lastDx = useRef(0);
  const velocity = useRef(new VelocityTracker());
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => clearPress, []);

  const reset = useCallback(() => {
    start.current = null;
    intent.current = "pending";
    lastDx.current = 0;
    velocity.current.reset();
    clearPress();
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || leaving) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    intent.current = "pending";
    velocity.current.reset();
    velocity.current.add(e.clientX, e.timeStamp);
    suppressClick.current = false;
    clearPress();
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      if (intent.current !== "pending") return;
      suppressClick.current = true;
      hapticSelection();
      onLongPress();
      start.current = null;
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (intent.current === "pending") {
      intent.current = disabled
        ? swipeIntent(mx, my) === "pending"
          ? "pending"
          : "vertical"
        : swipeIntent(mx, my);
      if (intent.current !== "pending") clearPress();
      if (intent.current === "horizontal") e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (intent.current !== "horizontal") return;
    velocity.current.add(e.clientX, e.timeStamp);
    if (crossedThreshold(lastDx.current, mx)) hapticLight();
    lastDx.current = mx;
    setDx(mx);
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const s = start.current;
    const wasHorizontal = intent.current === "horizontal";
    reset();
    if (!s || !wasHorizontal) return;
    suppressClick.current = true;
    const outcome = cancelled
      ? "cancel"
      : swipeOutcome(e.clientX - s.x, velocity.current.velocity());
    if (outcome === "done") {
      if (prefersReducedMotion()) {
        setDx(0);
        onDone();
        return;
      }
      setLeaving("right");
      setTimeout(onDone, 180);
      return;
    }
    setSettling(true);
    setDx(0);
    setTimeout(() => setSettling(false), 200);
    if (outcome === "lane") onLane();
  };

  const offset = leaving === "right" ? "100%" : `${rowOffset(dx)}px`;
  const armed = armedAction(dx);
  const side = dx > 0 ? "right" : dx < 0 ? "left" : null;

  return (
    <div
      className={`swipe-row ${className ?? ""}`}
      data-swiping={dx !== 0 || leaving ? "true" : undefined}
      data-side={leaving ?? side ?? undefined}
      data-armed={armed !== "cancel" ? armed : undefined}
    >
      {side === "right" || leaving ? (
        <span className="swipe-row__under swipe-row__under--done" aria-hidden="true">
          <span className="swipe-row__under-label" style={{ width: COMMIT_DISTANCE }}>
            <MailGlyph name="done" size={22} strokeWidth={2} />
            {t("mail.action.done")}
          </span>
        </span>
      ) : null}
      {side === "left" ? (
        <span className="swipe-row__under swipe-row__under--lane" aria-hidden="true">
          <span className="swipe-row__under-label" style={{ width: COMMIT_DISTANCE }}>
            <MailGlyph name="lane" size={22} strokeWidth={2} />
            {t("mail.action.lane")}
          </span>
        </span>
      ) : null}
      <div
        className="swipe-row__front"
        data-settling={settling || leaving ? "true" : undefined}
        style={{ transform: dx !== 0 || leaving ? `translateX(${offset})` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        // A link is natively draggable: a mouse drag would start a drag-and-drop
        // and cancel the pointer stream instead of swiping.
        onDragStart={(e) => e.preventDefault()}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClick.current = false;
          }
        }}
        onContextMenu={(e) => {
          // A long press on touch opens the OS context menu on links; the app owns it.
          if (
            e.nativeEvent instanceof PointerEvent ? e.nativeEvent.pointerType !== "mouse" : true
          ) {
            e.preventDefault();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
