"use client";

import { useT } from "../lib/i18n";
import { type ThemeChoice, useThemeChoice } from "../lib/theme";
import Tabs from "./ui/tabs";

/**
 * Theme picker: system (default, follows the OS live) or an explicit
 * light/dark override, persisted in localStorage. The pre-hydration script
 * in layout.tsx makes the first paint match, so switching here never
 * flashes.
 */
export default function AppearanceSection() {
  const [choice, setChoice] = useThemeChoice();
  const { t } = useT();

  const themeTabs = [
    { id: "system", label: t("settings.appearance.system") },
    { id: "light", label: t("settings.appearance.light") },
    { id: "dark", label: t("settings.appearance.dark") },
  ];

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-role-body text-ink">{t("settings.appearance.theme")}</p>
        <p className="mt-0.5 text-role-caption text-ink-mid">
          {t("settings.appearance.themeDesc")}
        </p>
      </div>
      <Tabs
        tabs={themeTabs}
        active={choice}
        onChange={(id) => setChoice(id as ThemeChoice)}
        ariaLabel={t("settings.appearance.theme")}
      />
    </div>
  );
}
