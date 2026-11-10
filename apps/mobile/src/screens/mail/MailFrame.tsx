/**
 * The mail body as the sender designed it, without letting it touch the app
 * (the mobile twin of the web reader's MailHtmlBody, #1455):
 *
 *  - <iframe sandbox="allow-same-origin"> — NO allow-scripts, ever: nothing in
 *    the mail runs, no forms, no popups, no top navigation. allow-same-origin
 *    (without scripts it grants the mail nothing) lets the app — not the mail
 *    — reach into the frame to measure its height and to take link taps: a
 *    script-less frame cannot hand a link to the native shell any other way,
 *    and in a Capacitor WebView a popup would open inside the app.
 *  - srcdoc from mail-html.ts: second sanitizing pass + a CSP meta allowing no
 *    loads but images, and remote images only after "이미지 보기".
 *  - Links: https → the system browser (@capacitor/browser); mailto → a new
 *    mail in Klorn; anything else does nothing.
 *  - Dark mode: uncoloured mail on the dark surface, designed mail on its own
 *    light sheet (mail-html.ts frameTheme).
 *  - cid: inline images are fetched through the authed API and inlined as
 *    data: urls (they come from Klorn, so they carry no tracking).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getServices } from "../../app/services";
import { useI18n } from "../../i18n/I18nProvider";
import { openExternal } from "../../platform/external";
import { MailGlyph } from "../../ui/MailGlyph";
import {
  buildMailSrcdoc,
  cidRefs,
  countRemoteImages,
  frameTheme,
  MAIL_FRAME_MIN_HEIGHT,
  mailLinkAction,
} from "./mail-html";

/** Frame sandbox: allow-same-origin only — never allow-scripts (the two together would void it). */
export const FRAME_SANDBOX = "allow-same-origin";
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const RASTER = /^image\/(png|gif|jpe?g|webp|bmp|avif)$/i;

function useDarkScheme(): boolean {
  const read = () => {
    const forced = document.documentElement.getAttribute("data-theme");
    if (forced === "dark") return true;
    if (forced === "light") return false;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const update = () => setDark(read());
    mq?.addEventListener?.("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq?.removeEventListener?.("change", update);
      mo.disconnect();
    };
  }, []);
  return dark;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function useInlineImages(emailId: string, html: string) {
  const cids = useMemo(() => cidRefs(html), [html]);
  const [images, setImages] = useState<Record<string, string> | null>(cids.length ? null : {});
  useEffect(() => {
    if (cids.length === 0) {
      setImages({});
      return;
    }
    let cancelled = false;
    setImages(null);
    void Promise.all(
      cids.map(async (cid) => {
        try {
          const blob = await getServices().api.getBlob(
            `/api/email/${encodeURIComponent(emailId)}/inline/${encodeURIComponent(cid)}`,
          );
          if (!RASTER.test(blob.type) || blob.size > MAX_INLINE_IMAGE_BYTES) return null;
          return [cid, await blobToDataUrl(blob)] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setImages(
        Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p !== null)),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [emailId, cids]);
  return images;
}

export function MailFrame({
  emailId,
  html,
  onMailto,
}: {
  emailId: string;
  html: string;
  onMailto: (address: string) => void;
}) {
  const { t } = useI18n();
  const dark = useDarkScheme();
  const [allowRemote, setAllowRemote] = useState(false);
  const [height, setHeight] = useState(MAIL_FRAME_MIN_HEIGHT);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inline = useInlineImages(emailId, html);
  const remote = useMemo(() => countRemoteImages(html), [html]);
  const theme = frameTheme(html, dark);
  const srcDoc = useMemo(
    () =>
      buildMailSrcdoc(html, {
        allowRemoteImages: allowRemote,
        inlineImages: inline ?? undefined,
        theme,
      }),
    [html, allowRemote, inline, theme],
  );
  const mailtoRef = useRef(onMailto);
  mailtoRef.current = onMailto;

  // Reset the image choice when a different mail opens.
  useEffect(() => setAllowRemote(false), [emailId]);

  const onLoad = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    const measure = () => {
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      setHeight(Math.max(MAIL_FRAME_MIN_HEIGHT, Math.ceil(h)));
    };
    measure();
    for (const img of doc.images) img.addEventListener("load", measure, { once: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (doc.body) ro?.observe(doc.body);
    // Links belong to the app: system browser for https, Klorn compose for mailto.
    doc.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      event.preventDefault();
      const action = mailLinkAction(anchor.getAttribute("href"));
      if (action?.kind === "browser") void openExternal(action.url);
      else if (action?.kind === "mailto") mailtoRef.current(action.address);
    });
    frame.addEventListener("load", () => ro?.disconnect(), { once: true });
  };

  return (
    <div className="mail-frame" data-theme-frame={theme}>
      {remote > 0 && !allowRemote ? (
        <div className="mail-frame__images">
          <MailGlyph name="image" size={18} className="mail-frame__images-icon" />
          <span className="mail-frame__images-text">{t("reader.images.blocked")}</span>
          <button
            type="button"
            className="button button--quiet mail-frame__images-btn"
            onClick={() => setAllowRemote(true)}
          >
            {t("reader.images.show")}
          </button>
        </div>
      ) : null}
      {inline === null ? (
        <div className="skeleton skeleton--block mail-frame__skeleton" aria-busy="true" />
      ) : (
        <iframe
          ref={frameRef}
          title={t("reader.frameTitle")}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          onLoad={onLoad}
          style={{ height }}
          className="mail-frame__iframe"
        />
      )}
    </div>
  );
}
