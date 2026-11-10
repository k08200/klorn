/**
 * What the Mail v2 list and reader hand each other across a navigation
 * (productization plan P5b, MAIL_V2), kept in sessionStorage:
 *
 *  - list → reader: the view the mail was opened from (lane, account, filter,
 *    search), so the reader's previous / next walk the same rows;
 *  - reader → list: the mail last read and where the list was scrolled, so
 *    going back lands on that row instead of the top.
 *
 * Every read validates what it finds; unreadable storage (private mode, a
 * corrupt value) degrades to "no context", never an error.
 */

import {
  ALL_ACCOUNTS,
  isLaneView,
  type ListView,
  SECONDARY_FILTERS,
  type SecondaryFilter,
} from "./model";

const CONTEXT_KEY = "klorn.mailV2.readerContext";
const SCROLL_KEY = "klorn.mailV2.listScroll";
const LAST_READ_KEY = "klorn.mailV2.lastRead";
const SEARCH_MAX = 200;

/** A reader opened without a list behind it (a link, a notification) walks all mail. */
export const NO_LIST_CONTEXT: ListView = {
  lane: "ALL",
  account: ALL_ACCOUNTS,
  filter: "none",
  search: "",
};

/** A stored value as a list view; anything malformed falls back field by field. */
export function parseListContext(raw: unknown): ListView {
  if (!raw || typeof raw !== "object") return NO_LIST_CONTEXT;
  const { lane, account, filter, search } = raw as Record<string, unknown>;
  return {
    lane: isLaneView(lane) ? lane : NO_LIST_CONTEXT.lane,
    account: typeof account === "string" && account ? account : ALL_ACCOUNTS,
    filter: (SECONDARY_FILTERS as readonly unknown[]).includes(filter)
      ? (filter as SecondaryFilter)
      : "none",
    search: typeof search === "string" ? search.slice(0, SEARCH_MAX) : "",
  };
}

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    // Storage unavailable: there is simply nothing to hand over.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the handoff just does not happen.
  }
}

export function saveListContext(view: ListView): void {
  const { lane, account, filter, search } = view;
  write(CONTEXT_KEY, JSON.stringify({ lane, account, filter, search }));
}

export function loadListContext(): ListView {
  try {
    return parseListContext(JSON.parse(read(CONTEXT_KEY) ?? "null"));
  } catch {
    return NO_LIST_CONTEXT;
  }
}

export function saveListScroll(scrollTop: number): void {
  write(SCROLL_KEY, String(Math.max(0, Math.round(scrollTop))));
}

/** The reader records the mail it is on, so the list can return to that row. */
export function saveLastRead(emailId: string): void {
  write(LAST_READ_KEY, emailId);
}

export interface ListReturn {
  emailId: string;
  scrollTop: number;
}

/**
 * Where to land when coming back from the reader. Reading does not clear it
 * (a state initializer may run twice); the list clears it once it has landed.
 */
export function peekListReturn(): ListReturn | null {
  const emailId = read(LAST_READ_KEY);
  if (!emailId) return null;
  const scrollTop = Number(read(SCROLL_KEY));
  return { emailId, scrollTop: Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0 };
}

export function clearListReturn(): void {
  write(LAST_READ_KEY, null);
}
