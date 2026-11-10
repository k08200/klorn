import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type BackAction, popTab, pushTab, resolveBack } from "./back";
import { formatRoute, parseRoute, type Route, sameRoute, type Tab, tabOf, tabRoot } from "./routes";

interface RouterValue {
  route: Route;
  navigate(route: Route, options?: { replace?: boolean }): void;
  /** Tab bar / rail tap: back to where that tab was; tapping the active tab pops to its root. */
  selectTab(tab: Tab): void;
  /** Run the back decision (Android back button); returns what it did. */
  back(): BackAction;
  /** Register an open sheet's close handler; returns the unregister function. */
  registerSheet(close: () => void): () => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentLocationRoute(): Route {
  const route = parseRoute(window.location.pathname, window.location.search);
  // "/" is Today; show its canonical path so a reload lands in the same place.
  return route;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(currentLocationRoute);
  const routeRef = useRef(route);
  routeRef.current = route;
  const tabHistory = useRef<Tab[]>([]);
  const lastByTab = useRef(new Map<Tab, Route>());
  const sheets = useRef<Array<() => void>>([]);

  const remember = useCallback((next: Route) => {
    const tab = tabOf(next);
    if (tab) {
      tabHistory.current = pushTab(tabHistory.current, tab);
      lastByTab.current.set(tab, next);
    }
  }, []);

  useEffect(() => {
    remember(routeRef.current);
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", formatRoute(routeRef.current));
    }
    const onPop = () => {
      const next = currentLocationRoute();
      remember(next);
      setRoute(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [remember]);

  const navigate = useCallback(
    (next: Route, options?: { replace?: boolean }) => {
      if (sameRoute(next, routeRef.current)) return;
      const path = formatRoute(next);
      if (options?.replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
      remember(next);
      setRoute(next);
    },
    [remember],
  );

  const selectTab = useCallback(
    (tab: Tab) => {
      const current = tabOf(routeRef.current);
      if (current === tab) navigate(tabRoot(tab));
      else navigate(lastByTab.current.get(tab) ?? tabRoot(tab));
    },
    [navigate],
  );

  const back = useCallback((): BackAction => {
    const action = resolveBack({
      sheetOpen: sheets.current.length > 0,
      route: routeRef.current,
      tabHistory: tabHistory.current,
    });
    if (action.kind === "closeSheet") {
      sheets.current[sheets.current.length - 1]?.();
    } else if (action.kind === "navigate") {
      const to = tabOf(action.route);
      if (to) tabHistory.current = popTab(tabHistory.current, to);
      const path = formatRoute(action.route);
      window.history.replaceState(null, "", path);
      if (to) lastByTab.current.set(to, action.route);
      setRoute(action.route);
    }
    return action;
  }, []);

  const registerSheet = useCallback((close: () => void) => {
    sheets.current.push(close);
    return () => {
      sheets.current = sheets.current.filter((fn) => fn !== close);
    };
  }, []);

  const value = useMemo(
    () => ({ route, navigate, selectTab, back, registerSheet }),
    [route, navigate, selectTab, back, registerSheet],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter outside RouterProvider");
  return value;
}

/** An in-app link: a real <a href> (long-press, a11y) that navigates without a reload. */
export function useLinkProps(to: Route) {
  const { navigate } = useRouter();
  return {
    href: formatRoute(to),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      navigate(to);
    },
  };
}
