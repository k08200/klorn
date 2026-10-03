/**
 * Settings section registry (productization plan §1). One route per section
 * under `/settings/[section]`; the order here is the nav order. Shared by the
 * server route (static params) and the client shell, so it stays free of
 * client-only imports.
 */

export const SETTINGS_SECTIONS = [
  { id: "accounts", labelKey: "settings.nav.accounts" },
  { id: "lanes", labelKey: "settings.nav.lanes" },
  { id: "assistant", labelKey: "settings.nav.assistant" },
  { id: "notifications", labelKey: "settings.nav.notifications" },
  { id: "team", labelKey: "settings.nav.team" },
  { id: "integrations", labelKey: "settings.nav.integrations" },
  { id: "appearance", labelKey: "settings.nav.appearance" },
  { id: "account-billing", labelKey: "settings.nav.accountBilling" },
  { id: "data", labelKey: "settings.nav.data" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "accounts";

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

export function settingsSectionHref(id: SettingsSectionId): string {
  return `/settings/${id}`;
}

/**
 * `/settings#<anchor>` targets from before the split, mapped to the section
 * that now holds the element. The keys are the element ids the single page
 * exposed (they are unchanged, so the fragment still scrolls to the control)
 * plus each section's own id.
 */
export const LEGACY_ANCHOR_SECTION: Readonly<Record<string, SettingsSectionId>> = {
  ...Object.fromEntries(SETTINGS_SECTIONS.map((section) => [section.id, section.id])),
  "profile-name": "account-billing",
  "current-pw": "account-billing",
  "new-pw": "account-billing",
  "set-pw": "account-billing",
  "profile-lang": "appearance",
  "profile-tz": "appearance",
  "reply-tone": "assistant",
  "auto-guideline": "assistant",
  "agent-interval": "assistant",
  "notification-language": "notifications",
  "briefing-time": "notifications",
  "quiet-hours-start": "notifications",
  "quiet-hours-end": "notifications",
};
