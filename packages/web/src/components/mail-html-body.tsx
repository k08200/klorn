"use client";

/**
 * Renders a message's sanitized HTML (`renderHtml` from GET /api/email/:id)
 * the way the sender designed it, without letting it touch the app:
 *
 *  - <iframe sandbox> WITHOUT allow-scripts or allow-same-origin: no script
 *    runs, and the frame has an opaque origin (no cookies, no storage, no
 *    reach into this document). allow-popups(+escape) only so links can open
 *    in a normal new tab; the frame can never navigate the app.
 *  - srcdoc built by lib/mail-html: second sanitizing pass, CSP meta that
 *    refuses every load but images, remote images off until asked.
 *  - cid: inline images are fetched here with the user's auth and inlined as
 *    data: urls — they come from our API, so they carry no tracking risk.
 *
 * No sender markup is ever placed in this document. Height is estimated (a
 * script-less, cross-origin frame cannot be measured) and capped; longer mail
 * scrolls inside the card.
 */

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { API_BASE, authHeaders } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  buildMailSrcdoc,
  cidRefs,
  countRemoteImages,
  estimateMailFrameHeight,
} from "../lib/mail-html";
import Button from "./ui/button";
import { Skeleton } from "./ui/skeleton";

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const RASTER_TYPES = /^image\/(png|gif|jpe?g|webp|bmp|avif)$/i;
/** Frame sandbox: no allow-scripts, no allow-same-origin — ever. */
const FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";
/** Demo mail (onboarding samples) has no stored MIME parts to fetch. */
const DEMO_ID_PREFIX = "demo-";
/** Inline images that have not arrived by then are reported missing. */
const INLINE_IMAGE_TIMEOUT_MS = 8000;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchInlineImage(
  emailId: string,
  cid: string,
  signal: AbortSignal,
): Promise<string | null> {
  const url = `${API_BASE}/api/email/${encodeURIComponent(emailId)}/inline/${encodeURIComponent(cid)}`;
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok) return null;
  const blob = await res.blob();
  if (!RASTER_TYPES.test(blob.type) || blob.size > MAX_INLINE_IMAGE_BYTES) return null;
  return blobToDataUrl(blob);
}

interface InlineImages {
  /** cid → data:image url; misses stay absent. */
  images: Readonly<Record<string, string>>;
  /** False until every cid has resolved or failed — the frame waits for it. */
  ready: boolean;
  /** cids that could not be loaded (shown to the user, not swallowed). */
  missing: number;
}

interface InlineState {
  key: string;
  images: Record<string, string>;
  missing: number;
}

const NO_IMAGES: Readonly<Record<string, string>> = {};

async function resolveCid(emailId: string, cid: string, signal: AbortSignal) {
  try {
    return [cid, await fetchInlineImage(emailId, cid, signal)] as const;
  } catch (err) {
    console.warn("[mail-html] inline image failed", { cid, aborted: signal.aborted }, err);
    return [cid, null] as const;
  }
}

/**
 * Resolves the message's cid: images once, before the frame is drawn, so the
 * iframe is built a single time instead of reloading (and losing its scroll)
 * as each image lands. Results are keyed by message + html: a stale result
 * can never dress a different message.
 */
function useInlineImages(emailId: string, html: string): InlineImages {
  const key = `${emailId}\n${html}`;
  const cids = useMemo(() => cidRefs(html), [html]);
  const needed = cids.length > 0 && !emailId.startsWith(DEMO_ID_PREFIX);
  const [state, setState] = useState<InlineState | null>(null);

  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INLINE_IMAGE_TIMEOUT_MS);
    Promise.all(cids.map((cid) => resolveCid(emailId, cid, controller.signal))).then((pairs) => {
      if (cancelled) return;
      const resolved = pairs.filter((p): p is readonly [string, string] => p[1] !== null);
      setState({
        key,
        images: Object.fromEntries(resolved),
        missing: pairs.length - resolved.length,
      });
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, needed, cids, emailId]);

  if (!needed) return { images: NO_IMAGES, ready: true, missing: 0 };
  if (state?.key !== key) return { images: NO_IMAGES, ready: false, missing: 0 };
  return { images: state.images, ready: true, missing: state.missing };
}

export interface MailHtmlBodyProps {
  emailId: string;
  /** Server-sanitized HTML (`renderHtml`). */
  html: string;
  /** The plain-text rendering, offered as an alternative view; null if none. */
  plain: ReactNode | null;
}

export function MailHtmlBody({ emailId, html, plain }: MailHtmlBodyProps) {
  const { t } = useT();
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [showPlain, setShowPlain] = useState(false);
  const inline = useInlineImages(emailId, html);

  const remoteCount = useMemo(() => countRemoteImages(html), [html]);
  const height = useMemo(() => estimateMailFrameHeight(html), [html]);
  const srcDoc = useMemo(
    () => buildMailSrcdoc(html, { allowRemoteImages, inlineImages: inline.images }),
    [html, allowRemoteImages, inline.images],
  );

  const imagesBlocked = remoteCount > 0 && !allowRemoteImages && !showPlain;

  return (
    <div className="flex flex-col gap-2">
      {(imagesBlocked || plain) && (
        <div className="flex flex-wrap items-center gap-2">
          {imagesBlocked && (
            <>
              <p className="min-w-0 flex-1 text-caption text-ink-mid">
                {t("mailHtml.imagesBlocked")}
              </p>
              <Button variant="secondary" size="sm" onClick={() => setAllowRemoteImages(true)}>
                {t("mailHtml.showImages")}
              </Button>
            </>
          )}
          {!imagesBlocked && <span className="flex-1" />}
          {plain && (
            <Button variant="ghost" size="sm" onClick={() => setShowPlain((v) => !v)}>
              {t(showPlain ? "mailHtml.showFormatted" : "mailHtml.showPlain")}
            </Button>
          )}
        </div>
      )}
      {showPlain && plain ? (
        plain
      ) : (
        <>
          {inline.ready ? (
            // A light sheet in both themes: mail is authored for a white page.
            <iframe
              title={t("mailHtml.frameTitle")}
              sandbox={FRAME_SANDBOX}
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
              style={{ height }}
              className="w-full rounded-card border border-line bg-white"
            />
          ) : (
            <Skeleton variant="block" height="h-60" />
          )}
          {inline.missing > 0 && (
            <p className="text-caption text-ink-mid">{t("mailHtml.inlineMissing")}</p>
          )}
        </>
      )}
    </div>
  );
}

export default MailHtmlBody;
