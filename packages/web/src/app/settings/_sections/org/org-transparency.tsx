"use client";

import type { OrgTransparencyResponse } from "@klorn/contract";
import { useT } from "../../../../lib/i18n";

/** What the organization can and cannot see of this member — the server's static truth. */
export function OrgTransparency({ data }: { data: OrgTransparencyResponse }) {
  const { t, locale } = useT();
  return (
    <section aria-labelledby="org-transparency-title" className="space-y-3">
      <h3 id="org-transparency-title" className="text-role-label font-semibold text-ink">
        {t("settings.org.transparency.title")}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="text-role-caption font-semibold text-ink-mid">
            {t("settings.org.transparency.can")}
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-role-body text-ink">
            {data.visibleToOrg.map((entry) => (
              <li key={entry.key}>
                {t(`settings.org.visible.${entry.key}`)}
                {entry.needsGrant && !entry.active && (
                  <span className="text-ink-dim"> {t("settings.org.transparency.notSharing")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-role-caption font-semibold text-ink-mid">
            {t("settings.org.transparency.cannot")}
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-role-body text-ink">
            {data.neverVisible.map((key) => (
              <li key={key}>{t(`settings.org.never.${key}`)}</li>
            ))}
          </ul>
        </div>
      </div>
      <div>
        <h4 className="text-role-caption font-semibold text-ink-mid">
          {t("settings.org.transparency.reads")}
        </h4>
        {data.freeBusyReads.length === 0 ? (
          <p className="text-role-caption text-ink-dim">{t("settings.org.transparency.noReads")}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-role-caption text-ink-mid">
            {data.freeBusyReads.map((read) => (
              <li key={`${read.at}-${read.by ?? ""}`}>
                {t("settings.org.transparency.read", {
                  who: read.by ?? t("settings.org.transparency.formerMember"),
                  date: new Date(read.at).toLocaleString(locale),
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
