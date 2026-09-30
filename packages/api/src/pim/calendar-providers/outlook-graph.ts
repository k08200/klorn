/**
 * Microsoft Graph HTTP for the OUTLOOK calendar provider (step C4 of
 * docs/providers/unified-platform-plan.md): one request helper with a timeout,
 * the `Prefer` header, an error that carries the HTTP status, and a guard that
 * keeps the bearer token on graph.microsoft.com.
 *
 * Plain fetch, like mail/outlook-oauth.ts: a calendarView read and a getSchedule
 * post do not justify a new dependency.
 *
 * Docs: Prefer: outlook.timezone on calendarView and getSchedule
 * https://learn.microsoft.com/graph/api/calendar-list-calendarview and
 * https://learn.microsoft.com/graph/api/calendar-getschedule ; immutable ids
 * https://learn.microsoft.com/graph/outlook-immutable-id
 */

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
export const GRAPH_BASE_URL = `${GRAPH_ORIGIN}/v1.0`;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_CODE_LENGTH = 64;
/** What an IANA zone name is made of; anything else is kept out of a header. */
const SAFE_TIME_ZONE = /^[A-Za-z0-9_+\-/]+$/;

/**
 * A Graph response that was not 2xx. Carries only the HTTP status and Graph's
 * short error code: the body can echo meeting subjects and addresses, so it is
 * never put in the message (which reaches logs and Sentry). `status` is what the
 * shared failure policy reads to tell a revoked token (401) from everything else.
 */
export class GraphRequestError extends Error {
  constructor(
    readonly status: number,
    readonly graphCode: string | null,
  ) {
    super(`Microsoft Graph request failed: http ${status}${graphCode ? ` ${graphCode}` : ""}`);
    this.name = "GraphRequestError";
  }
}

/**
 * The `Prefer` header: the zone times come back in (Graph answers UTC without
 * it) and immutable event ids, so an event keeps its id when the user moves it
 * between folders and is not synced as a new event.
 */
export function preferHeader(timeZone?: string): string {
  const preferences =
    timeZone && SAFE_TIME_ZONE.test(timeZone) ? [`outlook.timezone="${timeZone}"`] : [];
  return [...preferences, 'IdType="ImmutableId"'].join(", ");
}

/**
 * A page link from a response, or null when it is the last page. Only an https
 * link on graph.microsoft.com is followed: the token rides every request, and a
 * link to anywhere else would hand it over.
 */
export function nextLinkOf(page: { "@odata.nextLink"?: unknown }): string | null {
  const link = page["@odata.nextLink"];
  if (link === undefined || link === null || link === "") return null;
  if (typeof link !== "string" || !isGraphUrl(link)) {
    throw new Error("Refusing an @odata.nextLink that does not point at Microsoft Graph");
  }
  return link;
}

function isGraphUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === GRAPH_ORIGIN;
  } catch {
    return false;
  }
}

async function graphErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    const code = body.error?.code;
    return typeof code === "string" && code.length <= MAX_ERROR_CODE_LENGTH ? code : null;
  } catch {
    return null; // a non-JSON error body (a gateway page): the status alone says enough
  }
}

export interface GraphRequestOptions {
  readonly method: "GET" | "POST";
  /** The zone times are returned in; see {@link preferHeader}. */
  readonly timeZone?: string;
  readonly body?: unknown;
}

/** One authenticated Graph call; rejects with a {@link GraphRequestError} on a non-2xx. */
export async function graphRequest<T>(
  token: string,
  url: string,
  options: GraphRequestOptions,
): Promise<T> {
  if (!isGraphUrl(url)) throw new Error("Refusing a request that does not target Microsoft Graph");
  const res = await fetch(url, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Prefer: preferHeader(options.timeZone),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    // Fail fast: a hung call would stall the whole sync cycle for every account.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new GraphRequestError(res.status, await graphErrorCode(res));
  return (await res.json()) as T;
}
