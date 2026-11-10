/**
 * The adaptive shell: one LayoutPlan (size class × fold posture) decides the
 * navigation chrome and how many panes a screen gets. Screens read the plan
 * through useLayout(); the selected item lives in the route, so rotating,
 * folding or resizing a window re-lays out without losing it.
 */
import type { CSSProperties, ReactNode } from "react";
import { LayoutContext } from "./LayoutContext";
import { AssistantFab, NavRail, Sidebar, TabBar } from "./Navigation";
import type { LayoutPlan } from "./size-class";
import "./shell.css";

export function Shell({ plan, children }: { plan: LayoutPlan; children: ReactNode }) {
  const style = {
    "--hinge-start": plan.hinge ? `${plan.hinge.start}px` : undefined,
    "--hinge-size": plan.hinge ? `${plan.hinge.size}px` : undefined,
    "--list-width": `${plan.listWidth}px`,
  } as CSSProperties;
  return (
    <LayoutContext.Provider value={plan}>
      <div
        className="shell"
        data-nav={plan.nav}
        data-size={plan.sizeClass}
        data-posture={plan.posture}
        style={style}
      >
        {plan.nav === "sidebar" ? <Sidebar /> : null}
        {plan.nav === "rail" ? <NavRail /> : null}
        <div className="shell__content">{children}</div>
        {plan.nav === "tabs" ? <TabBar /> : null}
        {plan.assistantFab ? <AssistantFab /> : null}
      </div>
    </LayoutContext.Provider>
  );
}
