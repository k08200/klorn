/**
 * Account links (Gmail, Outlook, another Google calendar, Google Drive) run
 * in the SYSTEM browser. The server parks the authorization code and
 * deep-links `ai.klorn.app://link-complete?h=<handle>` back to the app
 * (routes/link-handoff.ts); the app finishes it with its own session through
 * POST /api/auth/link/complete — a link started by one session can never be
 * finished by another (account-linking CSRF).
 */
import { App } from "@capacitor/app";
import { NATIVE_OAUTH_SCHEME } from "../config";
import { isNative } from "./native";

const HANDLE = /^[0-9a-f]{64}$/;

/** The parked handle from `ai.klorn.app://link-complete?h=…`, or null for any other URL. */
export function parseLinkComplete(url: string, scheme = NATIVE_OAUTH_SCHEME): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${scheme}:`) return null;
  const target = parsed.host || parsed.pathname.replace(/^\/+/, "");
  if (target !== "link-complete") return null;
  const handle = parsed.searchParams.get("h");
  return handle && HANDLE.test(handle) ? handle : null;
}

export type LinkArea = "inbox" | "calendar" | "drive" | "google";
export type LinkResult =
  | "success"
  | "failed"
  | "unverified"
  | "pro"
  | "limit"
  | "self"
  | "scope-missing";

const AREA_PARAMS: Record<string, LinkArea> = {
  inbox: "inbox",
  linked: "calendar",
  drive: "drive",
  google: "google",
};

const RESULTS = new Set<LinkResult>([
  "success",
  "failed",
  "unverified",
  "pro",
  "limit",
  "self",
  "scope-missing",
]);

/**
 * What the finished link says, read from the web path the server answers
 * (`/settings?inbox=success`, `/calendar?linked=failed`, `/files?drive=limit`).
 * Anything unrecognised reads as a failure, never as a success.
 */
export function linkOutcome(next: string | null | undefined): {
  area: LinkArea;
  result: LinkResult;
} {
  let params: URLSearchParams;
  try {
    params = new URL(next ?? "", "https://app.invalid").searchParams;
  } catch {
    return { area: "inbox", result: "failed" };
  }
  for (const [param, area] of Object.entries(AREA_PARAMS)) {
    const value = params.get(param);
    if (value === null) continue;
    if (area === "google" && value === "connected") return { area, result: "success" };
    return { area, result: RESULTS.has(value as LinkResult) ? (value as LinkResult) : "failed" };
  }
  // A bare path ("/settings") is the 409 other-session answer: nothing was linked.
  return { area: "inbox", result: "failed" };
}

/** Listen for the link-complete deep link (native only); returns the unsubscribe. */
export function installLinkRelay(onHandle: (handle: string) => void): () => void {
  if (!isNative()) return () => {};
  let alive = true;
  let remove: (() => void) | null = null;
  void App.addListener("appUrlOpen", (event) => {
    const parked = parseLinkComplete(event.url);
    if (!parked) return;
    void import("@capacitor/browser").then(({ Browser }) => Browser.close().catch(() => {}));
    onHandle(parked);
  }).then((handle) => {
    if (!alive) void handle.remove();
    else remove = () => void handle.remove();
  });
  return () => {
    alive = false;
    remove?.();
  };
}
