"use client";

import { TeamsSection } from "../../../components/teams-section";
import { useT } from "../../../lib/i18n";
import { useTeamAvailability } from "./settings-shell";
import { PANEL, SECTION_TITLE } from "./shared";

export function TeamSection() {
  const { t } = useT();
  const available = useTeamAvailability();

  // The nav only offers this section to accounts with team mode; a direct
  // visit without it gets a plain statement instead of an empty page.
  if (available === false) {
    return <p className="text-body text-ink-mid">{t("settings.team.unavailable")}</p>;
  }

  return (
    <TeamsSection
      wrapper={(children) => (
        <section className="mb-8">
          <h2 className={SECTION_TITLE}>{t("settings.section.teams")}</h2>
          <div className={`${PANEL} p-5`}>{children}</div>
        </section>
      )}
    />
  );
}
