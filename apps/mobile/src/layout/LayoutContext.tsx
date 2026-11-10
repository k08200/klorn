import { createContext, useContext } from "react";
import type { LayoutPlan } from "./size-class";

export const LayoutContext = createContext<LayoutPlan | null>(null);

export function useLayout(): LayoutPlan {
  const plan = useContext(LayoutContext);
  if (!plan) throw new Error("useLayout outside Shell");
  return plan;
}
