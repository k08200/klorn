"use client";

import { useState } from "react";
import { RulesSection } from "../../../components/rules-section";
import { useT } from "../../../lib/i18n";
import { RulesDslPanel } from "./rules-dsl-panel";
import { PANEL, SECTION_TITLE } from "./shared";

export function LanesSection() {
  const { t } = useT();
  // Bumped when the rules text is applied, so the pin list above reloads.
  const [rulesVersion, setRulesVersion] = useState(0);
  return (
    // Rules — tier pins in the user's own words
    <section className="mb-8">
      <h2 className={SECTION_TITLE}>{t("settings.section.rules")}</h2>
      <div className={`${PANEL} p-5`}>
        <RulesSection key={rulesVersion} />
      </div>
      {/* Rules as text (RULES_DSL_ENABLED): renders nothing unless /me opens it. */}
      <RulesDslPanel onApplied={() => setRulesVersion((v) => v + 1)} />
    </section>
  );
}
