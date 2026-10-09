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
 * Where "Assistant" leads. The hub is the next step (P7); until it ships the
 * destination is the approvals page, which still lives at `/inbox`.
 */
export function assistantHref(): string {
  return LEGACY_HOME;
}

/** Routes that belong to the Assistant section of the unified nav. */
export const ASSISTANT_ROUTES = ["/inbox", "/briefing", "/chat"] as const;

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
