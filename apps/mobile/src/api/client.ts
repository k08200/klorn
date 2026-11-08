/**
 * The HTTP client. One transport for every platform: `fetch`. On native,
 * CapacitorHttp (capacitor.config.ts) patches window.fetch to run through the
 * OS HTTP stack, so the bundled origin meets no CORS; in the browser it is
 * plain fetch against the configured base. Tests and mock mode inject their
 * own transport.
 */

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export type ApiErrorKind = "network" | "timeout" | "http" | "unauthorized" | "parse";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status; 0 when no response arrived. */
  readonly status: number;
  /** The server's `error` string, when it sent one. */
  readonly serverMessage: string | null;
  /** The server's machine-readable `code` (e.g. ENTITLEMENT_REQUIRED), when it sent one. */
  readonly serverCode: string | null;

  constructor(
    kind: ApiErrorKind,
    status: number,
    message: string,
    serverMessage: string | null,
    serverCode: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.serverMessage = serverMessage;
    this.serverCode = serverCode;
  }

  /** No answer from the server at all: offline, DNS, TLS, timeout. */
  get isOffline(): boolean {
    return this.kind === "network" || this.kind === "timeout";
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** The `code` an API refusal carries when a plan gate said no (billing/entitlement-guard.ts). */
export const ENTITLEMENT_REQUIRED = "ENTITLEMENT_REQUIRED";

/**
 * True only for the server's plan refusal: 403 with code ENTITLEMENT_REQUIRED.
 * Any other 403 (a row that is not yours, a demo account) and every other
 * status is NOT "needs Pro" — the API never answers a client with 402.
 */
export function isEntitlementRefusal(err: unknown): boolean {
  return isApiError(err) && err.status === 403 && err.serverCode === ENTITLEMENT_REQUIRED;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  /** Called once per 401 on an authenticated, non-auth endpoint. */
  onUnauthorized?: () => void;
  transport?: Transport;
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Send no Authorization header (public auth endpoints). */
  anonymous?: boolean;
  headers?: Record<string, string>;
}

/**
 * 401 on these means wrong credentials or a spent code, never an expired
 * session — they must not sign the user out (same list as the web client).
 */
const NO_SIGN_OUT_ON_401 = ["/api/auth/login", "/api/auth/register", "/api/auth/exchange-code"];

export interface ApiClient {
  readonly baseUrl: string;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  del<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Binary GET (attachments): the body as a Blob, same auth / timeout / errors. */
  getBlob(path: string, options?: RequestOptions): Promise<Blob>;
  /** Raw status + parsed JSON, for endpoints whose 2xx codes differ in meaning (202). */
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<{ status: number; data: T }>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function errorMessageOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { error, message } = data as { error?: unknown; message?: unknown };
  if (typeof error === "string") return error;
  // Some routes answer { ok: false, message } (routes/imap-connect.ts).
  return typeof message === "string" ? message : null;
}

function errorCodeOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { code } = data as { code?: unknown };
  return typeof code === "string" ? code : null;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const transport: Transport = options.transport ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<{ status: number; data: T }> {
    if (!path.startsWith("/")) throw new Error(`API path must start with "/": ${path}`);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...requestOptions.headers,
    };
    // FormData (a multipart upload) goes as-is: fetch sets the boundary itself.
    const multipart = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
    const token = requestOptions.anonymous ? null : options.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const outer = requestOptions.signal;
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });

    let res: Response;
    try {
      res = await transport(`${options.baseUrl}${path}`, {
        method,
        headers,
        body:
          body === undefined ? undefined : multipart ? (body as FormData) : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (outer?.aborted) throw err;
      if (timedOut) throw new ApiError("timeout", 0, `Timed out: ${method} ${path}`, null);
      throw new ApiError("network", 0, `Network error: ${method} ${path}`, null);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }

    let data: unknown = null;
    const text = res.status === 204 ? "" : await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError("parse", res.status, `Bad JSON from ${path}`, null);
      }
    }

    if (res.status === 401) {
      const isAuthCall = NO_SIGN_OUT_ON_401.some((p) => path.startsWith(p));
      if (token && !isAuthCall) options.onUnauthorized?.();
      throw new ApiError("unauthorized", 401, `Unauthorized: ${path}`, errorMessageOf(data));
    }
    if (!res.ok) {
      throw new ApiError(
        "http",
        res.status,
        `HTTP ${res.status}: ${path}`,
        errorMessageOf(data),
        errorCodeOf(data),
      );
    }
    return { status: res.status, data: data as T };
  }

  async function getBlob(path: string, requestOptions: RequestOptions = {}): Promise<Blob> {
    if (!path.startsWith("/")) throw new Error(`API path must start with "/": ${path}`);
    const headers: Record<string, string> = { ...requestOptions.headers };
    const token = requestOptions.anonymous ? null : options.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await transport(`${options.baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(controller.signal.aborted ? "timeout" : "network", 0, `GET ${path}`, null);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      if (token) options.onUnauthorized?.();
      throw new ApiError("unauthorized", 401, `Unauthorized: ${path}`, null);
    }
    if (!res.ok) throw new ApiError("http", res.status, `HTTP ${res.status}: ${path}`, null);
    return res.blob();
  }

  return {
    baseUrl: options.baseUrl,
    request,
    getBlob,
    async get<T>(path: string, requestOptions?: RequestOptions) {
      return (await request<T>("GET", path, undefined, requestOptions)).data;
    },
    async post<T>(path: string, body?: unknown, requestOptions?: RequestOptions) {
      return (await request<T>("POST", path, body ?? {}, requestOptions)).data;
    },
    async del<T>(path: string, requestOptions?: RequestOptions) {
      return (await request<T>("DELETE", path, undefined, requestOptions)).data;
    },
  };
}
