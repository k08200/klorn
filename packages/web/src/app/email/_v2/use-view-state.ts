"use client";

/**
 * The Mail v2 view — lane, account, secondary filter, applied search — kept
 * across a trip to the reader and back (sessionStorage), so opening a mail
 * from PUSH returns to PUSH. The search is deliberately not persisted.
 */

import { useEffect, useState } from "react";
import {
  ALL_ACCOUNTS,
  DEFAULT_LANE,
  isLaneView,
  type ListView,
  SECONDARY_FILTERS,
  type SecondaryFilter,
} from "./model";

const DEFAULT_VIEW: ListView = {
  lane: DEFAULT_LANE,
  account: ALL_ACCOUNTS,
  filter: "none",
  search: "",
};
const VIEW_STORAGE_KEY = "klorn.mailV2.view";

function storedView(): ListView {
  if (typeof window === "undefined") return DEFAULT_VIEW;
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(VIEW_STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_VIEW;
    const { lane, account, filter } = raw as Record<string, unknown>;
    return {
      lane: isLaneView(lane) ? lane : DEFAULT_LANE,
      account: typeof account === "string" && account ? account : ALL_ACCOUNTS,
      filter: (SECONDARY_FILTERS as readonly unknown[]).includes(filter)
        ? (filter as SecondaryFilter)
        : "none",
      search: "",
    };
  } catch {
    // Unreadable storage (private mode, corrupt value): start from the default.
    return DEFAULT_VIEW;
  }
}

/**
 * Reads storage in the state initializer, which is safe only because Mail
 * renders behind AuthGuard — client-side, after hydration. Rendered during SSR
 * this would need to move into an effect.
 */
export function useViewState() {
  const [view, setView] = useState<ListView>(storedView);
  const { lane, account, filter } = view;
  useEffect(() => {
    try {
      window.sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ lane, account, filter }));
    } catch {
      // Storage unavailable: the view just does not persist.
    }
  }, [lane, account, filter]);
  return [view, setView] as const;
}
