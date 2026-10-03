"use client";

import type { ComponentType } from "react";
import { useT } from "../../../lib/i18n";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../sections";
import { AccountBillingSection } from "./account-billing-section";
import { AccountsSection } from "./accounts-section";
import { AppearanceLanguageSection } from "./appearance-language-section";
import { AssistantSection } from "./assistant-section";
import { DataSection } from "./data-section";
import { IntegrationsSection } from "./integrations-section";
import { LanesSection } from "./lanes-section";
import { NotificationsSection } from "./notifications-section";
import { SectionHeader } from "./section-header";
import { TeamSection } from "./team-section";

const SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType> = {
  accounts: AccountsSection,
  lanes: LanesSection,
  assistant: AssistantSection,
  notifications: NotificationsSection,
  team: TeamSection,
  integrations: IntegrationsSection,
  appearance: AppearanceLanguageSection,
  "account-billing": AccountBillingSection,
  data: DataSection,
};

export function SectionView({ id }: { id: SettingsSectionId }) {
  const { t } = useT();
  const Section = SECTION_COMPONENTS[id];
  const labelKey = SETTINGS_SECTIONS.find((section) => section.id === id)?.labelKey ?? "";

  return (
    <>
      <SectionHeader title={t(labelKey)} />
      <Section />
    </>
  );
}
