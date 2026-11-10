/**
 * List + detail panes for Mail / Calendar / Files / Assistant.
 *   compact          one pane: the detail when one is open, else the list
 *   medium/expanded  list (plan.listWidth) | detail
 *   book (vertical hinge)   list left of the hinge, detail right of it
 *   tabletop (horizontal)   detail (reading) above the hinge, list below
 */
import type { ReactNode } from "react";
import { useLayout } from "./LayoutContext";

interface ListDetailProps {
  list: ReactNode;
  detail: ReactNode | null;
  /** Shown in the detail pane on wide layouts when nothing is selected. */
  emptyDetail: ReactNode;
  listLabel: string;
  detailLabel: string;
}

export function ListDetail({ list, detail, emptyDetail, listLabel, detailLabel }: ListDetailProps) {
  const plan = useLayout();
  if (plan.panes === 1 && plan.posture !== "tabletop") {
    return (
      <div className="panes panes--single">
        {detail ? (
          <section className="pane pane--detail" aria-label={detailLabel}>
            {detail}
          </section>
        ) : (
          <section className="pane pane--list" aria-label={listLabel}>
            {list}
          </section>
        )}
      </div>
    );
  }
  if (plan.posture === "tabletop") {
    return (
      <div className="panes panes--tabletop">
        <section className="pane pane--detail" aria-label={detailLabel}>
          {detail ?? emptyDetail}
        </section>
        <div className="panes__hinge" aria-hidden="true" />
        <section className="pane pane--list" aria-label={listLabel}>
          {list}
        </section>
      </div>
    );
  }
  return (
    <div className={`panes panes--split${plan.posture === "book" ? " panes--book" : ""}`}>
      <section className="pane pane--list" aria-label={listLabel}>
        {list}
      </section>
      <div className="panes__divider" aria-hidden="true" />
      <section className="pane pane--detail" aria-label={detailLabel}>
        {detail ?? emptyDetail}
      </section>
    </div>
  );
}
