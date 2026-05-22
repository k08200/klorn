"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Locale = "en" | "ko";

// English is the source of truth. Saved "ko" profiles intentionally resolve to
// English copy so the product stays English-first.
const enTranslations: Record<string, string> = {
  // Nav
  "nav.dashboard": "Dashboard",
  "nav.chat": "Chat",
  "nav.email": "Email",
  "nav.calendar": "Calendar",
  "nav.tasks": "Tasks",
  "nav.notes": "Notes",
  "nav.contacts": "Contacts",
  "nav.reminders": "Reminders",
  "nav.auto": "Auto",
  // Auth
  "auth.signIn": "Sign in",
  "auth.signUp": "Create account",
  "auth.signingIn": "Signing in...",
  "auth.creatingAccount": "Creating account...",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.name": "Name",
  "auth.noAccount": "Don't have an account? Sign up",
  "auth.hasAccount": "Already have an account? Sign in",
  "auth.backHome": "Back to home",
  "auth.welcome": "Welcome back!",
  "auth.accountCreated": "Account created!",
  // Settings
  "settings.title": "Settings",
  "settings.subtitle": "Manage your profile, integrations, and preferences",
  "settings.profile": "Profile",
  "settings.security": "Security",
  "settings.integrations": "Integrations",
  "settings.displayName": "Display Name",
  "settings.language": "Language",
  "settings.timezone": "Timezone",
  "settings.saveProfile": "Save Profile",
  "settings.saved": "Saved!",
  "settings.currentPassword": "Current Password",
  "settings.newPassword": "New Password",
  "settings.changePassword": "Change Password",
  "settings.changing": "Changing...",
  "settings.connected": "Connected",
  "settings.disconnect": "Disconnect",
  "settings.connect": "Connect",
  "settings.envVars": "Set env vars to enable",
  "settings.quickActions": "Quick Actions",
  "settings.dailyBriefing": "Daily Briefing",
  "settings.generateNow": "Generate Now",
  "settings.capabilities": "Decision OS Surfaces",
  "settings.data": "Data",
  "settings.exportData": "Export Data",
  "settings.export": "Export",
  "settings.dangerZone": "Danger Zone",
  "settings.deleteAll": "Delete All Data",
  "settings.deleteBtn": "Delete All",
  "settings.about": "About",
  // Dashboard
  "dashboard.greeting": "Good {timeOfDay}, {name}",
  "dashboard.morning": "morning",
  "dashboard.afternoon": "afternoon",
  "dashboard.evening": "evening",
  // Chat
  "chat.newConversation": "New decision thread",
  "chat.typeMessage": "Ask for a decision, context trace, or next move...",
  "chat.send": "Send",
  // Briefing
  "briefing.learningMode":
    "Klorn learns mail and calendar patterns during the first 2-3 days. The top actions get sharper as you use the workspace.",
  // Common
  "common.loading": "Loading...",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.delete": "Delete",
  "common.save": "Save",
  "common.or": "or",
  // Skills
  "skills.title": "Skills",
  "skills.subtitle": "Reusable workflows Klorn can run for you",
  "skills.newSkill": "+ New Skill",
  "skills.edit": "Edit Skill",
  "skills.name": "Skill name",
  "skills.description": "Description (optional)",
  "skills.prompt": "Prompt template",
  "skills.create": "Create",
  "skills.update": "Update",
  "skills.empty": "No skills yet",
  // Approval UX
  "approval.approve": "Approve",
  "approval.reject": "Reject",
  "approval.alwaysAllow": "Always allow",
  "approval.neverSuggest": "Never suggest this",
  // Notifications
  "notif.title": "Notifications",
  "notif.push": "Push Notifications",
  "notif.preferences": "Which notifications do you want?",
  "notif.quietHours": "Quiet hours",
  "notif.quietHoursDesc": "Suppress push notifications during this window",
  "notif.categoryEmailUrgent": "Urgent email alerts",
  "notif.categoryMeeting": "Meeting reminders",
  "notif.categoryTaskDue": "Task due soon or overdue",
  "notif.categoryAgentProposal": "Agent proposals",
  "notif.categoryDailyBriefing": "Daily briefing",
};

const translations: Record<Locale, Record<string, string>> = {
  en: enTranslations,
  ko: enTranslations,
};

/** Verify all locales have the same set of keys. Warns in dev builds. */
function verifyTranslationSymmetry(): void {
  const locales = Object.keys(translations) as Locale[];
  if (locales.length === 0) return;
  const base = locales[0];
  const baseKeys = new Set(Object.keys(translations[base]));

  for (const locale of locales.slice(1)) {
    const localeKeys = new Set(Object.keys(translations[locale]));
    const missing = [...baseKeys].filter((k) => !localeKeys.has(k));
    const extra = [...localeKeys].filter((k) => !baseKeys.has(k));
    if (missing.length > 0) {
      // biome-ignore lint/suspicious/noConsole: dev-time i18n validation
      console.warn(`[i18n] "${locale}" missing keys: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      // biome-ignore lint/suspicious/noConsole: dev-time i18n validation
      console.warn(`[i18n] "${locale}" has unexpected keys: ${extra.join(", ")}`);
    }
  }
}

if (process.env.NODE_ENV !== "production") {
  verifyTranslationSymmetry();
}

interface I18nContextType {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);
const PROFILE_KEY = "klorn-profile";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_PROFILE_KEY = `${LEGACY_KEY_PREFIX}-profile`;

function getStoredProfile(): string | null {
  const stored = localStorage.getItem(PROFILE_KEY);
  if (stored) return stored;
  const legacyStored = localStorage.getItem(LEGACY_PROFILE_KEY);
  if (legacyStored) {
    localStorage.setItem(PROFILE_KEY, legacyStored);
    localStorage.removeItem(LEGACY_PROFILE_KEY);
  }
  return legacyStored;
}

function detectLocale(): Locale {
  try {
    const stored = getStoredProfile();
    if (stored) {
      const { language } = JSON.parse(stored);
      if (language === "en") return "en";
    }
  } catch {
    // ignore
  }
  return "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    setLocaleState(detectLocale());

    // Re-detect when profile settings change in another tab/window
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROFILE_KEY || e.key === LEGACY_PROFILE_KEY) {
        setLocaleState(detectLocale());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string>): string => {
      let str = translations[locale]?.[key] || translations.en[key] || key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(`{${k}}`, v);
        }
      }
      return str;
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within I18nProvider");
  return ctx;
}
