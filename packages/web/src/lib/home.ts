/**
 * Which route is home (productization plan P6, UNIFIED_HOME).
 *
 * Home is Today only when the server says so (`user.unifiedHome`); otherwise
 * it is the legacy home, `/inbox`. Two callers cannot ask the user object:
 * the root redirect and the native sign-in both navigate before
 * GET /api/auth/me has answered. For them the last answer the server gave on
 * this device is kept as a hint in localStorage. With the flag off the hint is
 * never written, so those callers go exactly where they always went.
 */

export const LEGACY_HOME = "/inbox";
export const TODAY_HOME = "/today";

const HOME_HINT_KEY = "klorn.unifiedHome";

interface HomeFlag {
  unifiedHome?: boolean;
}

export function homePath(user: HomeFlag | null | undefined): string {
  return user?.unifiedHome === true ? TODAY_HOME : LEGACY_HOME;
}

/**
 * Where a sign-in or a registration lands: the page the visitor was sent
 * from (`next`), or — with none — their home.
 */
export function signInDestination(
  next: string | null | undefined,
  user: HomeFlag | null | undefined,
): string {
  return next || homePath(user);
}

/** The Assistant hub (productization plan P7). Dark while the flag is off. */
export const ASSISTANT_HUB = "/assistant";
export const ASSISTANT_APPROVALS = "/assistant/approvals";
export const ASSISTANT_BRIEFING = "/assistant/briefing";
export const ASSISTANT_ACTIVITY = "/assistant/activity";
export const ASSISTANT_CHAT = "/assistant/chat";

/** Where "Assistant" leads: the hub's first page, Approvals. */
export function assistantHref(): string {
  return ASSISTANT_APPROVALS;
}

/**
 * Routes that belong to the Assistant section of the unified nav. The legacy
 * routes stay listed: each hands over to its hub page, and `/chat` is still a
 * page of its own.
 */
export const ASSISTANT_ROUTES = [ASSISTANT_HUB, "/inbox", "/briefing", "/chat"] as const;

/**
 * Legacy route -> hub page, and back. Both are fixed tables looked up with
 * Map.get, so a pathname can never pick a destination that is not listed here
 * (an object index would also answer "constructor").
 */
const HUB_BY_LEGACY: ReadonlyMap<string, string> = new Map([
  [LEGACY_HOME, ASSISTANT_APPROVALS],
  ["/briefing", ASSISTANT_BRIEFING],
  ["/inbox/receipt", ASSISTANT_ACTIVITY],
]);

const LEGACY_BY_HUB: ReadonlyMap<string, string> = new Map([
  [ASSISTANT_APPROVALS, LEGACY_HOME],
  [ASSISTANT_BRIEFING, "/briefing"],
  [ASSISTANT_ACTIVITY, "/inbox/receipt"],
  [ASSISTANT_CHAT, "/chat"],
]);

function trimSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** The query is carried over only in its own position: after one "?". */
function withQuery(target: string, search: string): string {
  return search.startsWith("?") && search.length > 1 ? `${target}${search}` : target;
}

/**
 * With UNIFIED_HOME on: the hub page a legacy route hands over to, or null
 * when the route is not one of the three that moved.
 */
export function hubRouteFor(pathname: string, search: string): string | null {
  const target = HUB_BY_LEGACY.get(trimSlash(pathname));
  return target === undefined ? null : withQuery(target, search);
}

/**
 * With UNIFIED_HOME off: the legacy route a hub page hands back to. Anything
 * under the hub that is not a known page goes to the legacy home.
 */
export function legacyRouteFor(pathname: string, search: string): string {
  return withQuery(LEGACY_BY_HUB.get(trimSlash(pathname)) ?? LEGACY_HOME, search);
}

/** Record what the server said, for the callers that route before it answers. */
export function rememberHome(user: HomeFlag | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    if (user?.unifiedHome === true) window.localStorage.setItem(HOME_HINT_KEY, "1");
    else window.localStorage.removeItem(HOME_HINT_KEY);
  } catch {
    // Storage unavailable (private mode): no hint, the legacy home is used.
  }
}

/** Home as last reported on this device; the legacy home when unknown. */
export function rememberedHome(): string {
  if (typeof window === "undefined") return LEGACY_HOME;
  try {
    return window.localStorage.getItem(HOME_HINT_KEY) === "1" ? TODAY_HOME : LEGACY_HOME;
  } catch {
    return LEGACY_HOME;
  }
}

const LEGACY_LANDING_KEY = "klorn.legacyLanding";

/**
 * Where a caller without the user object should land, as last reported on
 * this device. When that is the legacy home, the landing is marked: if the
 * server then says home is Today (the first visit after the flag flips), the
 * app shell moves the visitor on. A deliberate visit to `/inbox` is never
 * marked, so legacy deep links keep working.
 */
export function landingHome(): string {
  const home = rememberedHome();
  if (home === LEGACY_HOME) {
    try {
      window.sessionStorage.setItem(LEGACY_LANDING_KEY, "1");
    } catch {
      // Storage unavailable: the visitor stays on the legacy home this once.
    }
  }
  return home;
}

/**
 * Forget what this device was told about home, on sign-out: the next person
 * to sign in here starts from the legacy home until the server says otherwise.
 */
export function forgetHome(): void {
  try {
    window.localStorage.removeItem(HOME_HINT_KEY);
    window.sessionStorage.removeItem(LEGACY_LANDING_KEY);
  } catch {
    // Storage unavailable: there was nothing stored to forget.
  }
}

export type LandingStep = "wait" | "discard" | "resolve";

/**
 * What the app shell does with a marked landing on this route. The redirect
 * away from `/` may still be in flight, so that route waits. Only `/inbox`
 * can be the marked landing; any other route means the visitor went
 * somewhere on purpose, so the mark is dropped unused. On `/inbox` the mark
 * is resolved once the user (and with it the flag) has loaded.
 */
export function landingStep(pathname: string, userLoaded: boolean): LandingStep {
  if (pathname === "/") return "wait";
  if (pathname !== LEGACY_HOME) return "discard";
  return userLoaded ? "resolve" : "wait";
}

/**
 * Whether a marked landing is still waiting to be resolved. The legacy home
 * asks before handing over to the hub: a marked landing belongs to Today.
 */
export function hasLegacyLanding(): boolean {
  try {
    return window.sessionStorage.getItem(LEGACY_LANDING_KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether this visit was a marked landing on the legacy home; clears the mark. */
export function takeLegacyLanding(): boolean {
  try {
    const marked = window.sessionStorage.getItem(LEGACY_LANDING_KEY) === "1";
    if (marked) window.sessionStorage.removeItem(LEGACY_LANDING_KEY);
    return marked;
  } catch {
    return false;
  }
}
