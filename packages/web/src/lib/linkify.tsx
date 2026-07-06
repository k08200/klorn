"use client";

// Safe linkification of untrusted plain text (email bodies).
//
// The text arrives HTML-escaped by React (we only ever emit text nodes plus
// our own <a> elements — raw email HTML is never injected). Only http(s) and
// mailto targets become anchors; anything else stays inert text. In the
// Capacitor shell external navigation is blocked by the allowNavigation
// allowlist, so clicks route through the system browser (same pattern as the
// OAuth flow in lib/api.ts).

import type { ReactNode } from "react";
import { isNativePlatform } from "./native/capacitor";
import { captureClientError } from "./sentry";

// Match http(s) URLs and mailto addresses in free text. Conservative on
// trailing punctuation so "…link: https://x.co/abc." doesn't eat the dot.
const URL_PATTERN = /(https?:\/\/[^\s<>"')\]]+|mailto:[^\s<>"')\]]+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?）)\]}>'"]+$/;

function openExternal(url: string, event: React.MouseEvent) {
  if (!isNativePlatform()) return; // web: let the anchor navigate normally
  event.preventDefault();
  void import("@capacitor/browser")
    .then(({ Browser }) => Browser.open({ url }))
    .catch((err) => {
      // preventDefault already suppressed the anchor — without a fallback the
      // tap would be a silent dead end on a broken plugin bridge.
      console.error("[LINKIFY] system browser open failed:", err);
      captureClientError(err, { context: "linkify.openExternal" });
      window.open(url, "_blank", "noopener,noreferrer");
    });
}

/** Split untrusted plain text into text nodes + safe clickable anchors. */
export function linkifyText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];

    // Peel trailing sentence punctuation off the URL.
    const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    if (trailing) url = url.slice(0, -trailing.length);
    if (!/^(https?:\/\/|mailto:)/i.test(url)) continue;

    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(
      <a
        key={`lnk-${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="break-all text-accent underline underline-offset-2 hover:opacity-80"
        onClick={(e) => openExternal(url, e)}
      >
        {url}
      </a>,
    );
    lastIndex = start + match[0].length - trailing.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
