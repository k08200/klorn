/**
 * Android back button, as a pure decision (canvas notes.gestures):
 * close the top sheet → close the open detail → go to the previous tab →
 * (on Today with nothing to unwind) leave the app.
 */
import { hasDetail, type Route, type Tab, tabOf, withoutDetail } from "./routes";

export type BackAction =
  | { kind: "closeSheet" }
  | { kind: "navigate"; route: Route }
  | { kind: "exit" };

export interface BackState {
  sheetOpen: boolean;
  route: Route;
  /** Tabs visited, oldest first; the last entry is the current tab. */
  tabHistory: readonly Tab[];
}

/** Settings pages sit under Settings (the Accounts artboard's back label is "설정"). */
export function parentOf(route: Route): Route | null {
  if (route.name === "settings" && route.section) return { name: "settings" };
  if (route.name === "accounts") return { name: "settings" };
  return null;
}

export function resolveBack(state: BackState): BackAction {
  if (state.sheetOpen) return { kind: "closeSheet" };
  if (hasDetail(state.route)) return { kind: "navigate", route: withoutDetail(state.route) };
  const parent = parentOf(state.route);
  if (parent) return { kind: "navigate", route: parent };
  const current = tabOf(state.route);
  const history = state.tabHistory.filter((tab, i, all) => i === 0 || all[i - 1] !== tab);
  if (current !== null) {
    for (let i = history.length - 1; i >= 0; i--) {
      const tab = history[i];
      if (tab !== undefined && tab !== current) return { kind: "navigate", route: { name: tab } };
    }
  }
  if (state.route.name !== "today") return { kind: "navigate", route: { name: "today" } };
  return { kind: "exit" };
}

/** Record a tab visit, keeping the list short and free of back-to-back repeats. */
export function pushTab(history: readonly Tab[], tab: Tab, max = 8): Tab[] {
  const next = history[history.length - 1] === tab ? [...history] : [...history, tab];
  return next.slice(-max);
}

/** Drop the current tab after a back navigation away from it. */
export function popTab(history: readonly Tab[], to: Tab): Tab[] {
  const idx = history.lastIndexOf(to);
  return idx === -1 ? [to] : history.slice(0, idx + 1);
}
