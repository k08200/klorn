"use client";

import { RulesSection } from "../../../components/rules-section";
import { useT } from "../../../lib/i18n";
import { PANEL, SECTION_TITLE } from "./shared";

export function LanesSection() {
  const { t } = useT();
  return (
    // Rules — tier pins in the user's own words
    <section className="mb-8">
      <h2 className={SECTION_TITLE}>{t("settings.section.rules")}</h2>
      <div className={`${PANEL} p-5`}>
        <RulesSection />
      </div>
    </section>
  );
}
