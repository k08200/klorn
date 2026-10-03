"use client";

import AppearanceSection from "../../../components/appearance-section";
import { useT } from "../../../lib/i18n";
import { ProfilePanel } from "./profile-panel";
import { PANEL, SECTION_TITLE } from "./shared";

export function AppearanceLanguageSection() {
  const { t } = useT();
  return (
    <>
      <section className="mb-8">
        <h2 className={SECTION_TITLE}>{t("settings.section.appearance")}</h2>
        <div className={`${PANEL} p-5`}>
          <AppearanceSection />
        </div>
      </section>
      <ProfilePanel fields="locale" />
    </>
  );
}
