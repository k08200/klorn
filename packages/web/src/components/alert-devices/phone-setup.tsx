"use client";

import qrcode from "qrcode-generator";
import { useId, useMemo } from "react";
import { PHONE_SETUP_URL } from "../../lib/alert-devices";
import { useT } from "../../lib/i18n";
import { IosHomeScreenSteps } from "../ios-install-hint";

/** Quiet zone around the code, in modules (the QR spec asks for four). */
const QUIET_ZONE = 4;

/**
 * One SVG path for the dark modules of a QR code. Encoded in the browser by
 * qrcode-generator (MIT, no dependencies) — the URL never goes to a QR web
 * service.
 */
function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
    }
  }
  return { size: count + QUIET_ZONE * 2, d: parts.join("") };
}

/**
 * Phone setup from a desktop browser (N7): a QR code for the app and the
 * steps that make a phone ring — Add to Home Screen on iPhone, allow
 * notifications in Chrome on Android.
 */
export function PhoneSetup({ id }: { id?: string }) {
  const { t } = useT();
  const { size, d } = useMemo(() => qrPath(PHONE_SETUP_URL), []);
  const iphoneId = useId();
  const androidId = useId();
  const displayUrl = PHONE_SETUP_URL.replace(/^https:\/\//, "");

  return (
    <div id={id} className="mt-3 rounded-card border border-line-soft bg-surface-raised p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <figure className="shrink-0 self-center sm:self-start">
          {/* QR codes need dark-on-light in both themes, so the colours are fixed. */}
          <svg
            role="img"
            aria-label={t("alertDevices.phone.qrLabel", { url: displayUrl })}
            viewBox={`0 0 ${size} ${size}`}
            className="size-36 rounded-control"
            shapeRendering="crispEdges"
          >
            <rect width={size} height={size} fill="#ffffff" />
            <path d={d} fill="#000000" />
          </svg>
          <figcaption aria-hidden="true" className="mt-1.5 text-center text-role-meta text-ink-mid">
            {displayUrl}
          </figcaption>
        </figure>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-role-body text-ink">{t("alertDevices.phone.scan")}</p>
          <section aria-labelledby={iphoneId}>
            <h3 id={iphoneId} className="text-role-label text-ink">
              {t("alertDevices.phone.iphone")}
            </h3>
            <IosHomeScreenSteps className="mt-1.5" />
          </section>
          <section aria-labelledby={androidId}>
            <h3 id={androidId} className="text-role-label text-ink">
              {t("alertDevices.phone.android")}
            </h3>
            <p className="mt-1 text-role-body text-ink-soft">
              {t("alertDevices.phone.androidStep")}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
