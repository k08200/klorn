import type { MessageKey } from "../i18n";
import type { Tab } from "../router/routes";
import type { IconName } from "../ui/Icon";

export interface NavItem {
  tab: Tab;
  label: MessageKey;
  icon: IconName;
}

/** The five destinations, in the artboards' order: 오늘 · 메일 · 캘린더 · 파일 · 도우미. */
export const NAV_ITEMS: readonly NavItem[] = [
  { tab: "today", label: "tab.today", icon: "home" },
  { tab: "mail", label: "tab.mail", icon: "mail" },
  { tab: "calendar", label: "tab.calendar", icon: "calendar" },
  { tab: "files", label: "tab.files", icon: "files" },
  { tab: "assistant", label: "tab.assistant", icon: "spark" },
];
