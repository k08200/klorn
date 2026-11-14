"use client";

import { TeamsSection } from "../../../components/teams-section";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { showTeamSection } from "./org/model";
import { OrgPanel } from "./org/org-panel";
import { useTeamAvailability } from "./settings-shell";
import { PANEL, SECTION_TITLE } from "./shared";

export function TeamSection() {
  const { t } = useT();
  const { user } = useAuth();
  const available = useTeamAvailability();
  const teams = user?.teams === true;

  // The nav only offers this section to accounts with team mode or Klorn
  // Teams; a direct visit without either gets a plain statement instead of an
  // empty page.
  if (available !== null && !showTeamSection(available, teams)) {
    return <p className="text-role-body text-ink-mid">{t("settings.team.unavailable")}</p>;
  }

  return (
    <>
      {teams && <OrgPanel />}
      {available === true && (
        <TeamsSection
          wrapper={(children) => (
            <section className="mb-8">
              <h2 className={SECTION_TITLE}>{t("settings.section.teams")}</h2>
              <div className={`${PANEL} p-5`}>{children}</div>
            </section>
          )}
        />
      )}
    </>
  );
}
