"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Locale = "en" | "ko";

// Translation dictionaries
const translations: Record<Locale, Record<string, string>> = {
  en: {
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
      "Jigeum is learning your email and calendar patterns for the first 2-3 days. Key picks get sharper as you use it.",
    // Common
    "common.loading": "Loading...",
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.delete": "Delete",
    "common.save": "Save",
    "common.or": "or",
    // Skills
    "skills.title": "Skills",
    "skills.subtitle": "Reusable workflows Jigeum can run for you",
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
  },
  ko: {
    // Nav
    "nav.dashboard": "대시보드",
    "nav.chat": "채팅",
    "nav.email": "이메일",
    "nav.calendar": "캘린더",
    "nav.tasks": "할 일",
    "nav.notes": "메모",
    "nav.contacts": "연락처",
    "nav.reminders": "리마인더",
    "nav.auto": "자동화",
    // Auth
    "auth.signIn": "로그인",
    "auth.signUp": "회원가입",
    "auth.signingIn": "로그인 중...",
    "auth.creatingAccount": "계정 생성 중...",
    "auth.email": "이메일",
    "auth.password": "비밀번호",
    "auth.name": "이름",
    "auth.noAccount": "계정이 없으신가요? 회원가입",
    "auth.hasAccount": "이미 계정이 있으신가요? 로그인",
    "auth.backHome": "홈으로 돌아가기",
    "auth.welcome": "다시 오셨군요!",
    "auth.accountCreated": "계정이 생성되었습니다!",
    // Settings
    "settings.title": "설정",
    "settings.subtitle": "프로필, 연동, 의사결정 흐름을 관리하세요",
    "settings.profile": "프로필",
    "settings.security": "보안",
    "settings.integrations": "연동",
    "settings.displayName": "표시 이름",
    "settings.language": "언어",
    "settings.timezone": "시간대",
    "settings.saveProfile": "프로필 저장",
    "settings.saved": "저장됨!",
    "settings.currentPassword": "현재 비밀번호",
    "settings.newPassword": "새 비밀번호",
    "settings.changePassword": "비밀번호 변경",
    "settings.changing": "변경 중...",
    "settings.connected": "연결됨",
    "settings.disconnect": "연결 해제",
    "settings.connect": "연결",
    "settings.envVars": "환경변수 설정 필요",
    "settings.quickActions": "빠른 결정",
    "settings.dailyBriefing": "일일 브리핑",
    "settings.generateNow": "지금 생성",
    "settings.capabilities": "Decision OS 표면",
    "settings.data": "데이터",
    "settings.exportData": "데이터 내보내기",
    "settings.export": "내보내기",
    "settings.dangerZone": "위험 구역",
    "settings.deleteAll": "전체 데이터 삭제",
    "settings.deleteBtn": "전체 삭제",
    "settings.about": "정보",
    // Dashboard
    "dashboard.greeting": "{name}님, 좋은 {timeOfDay}입니다",
    "dashboard.morning": "아침",
    "dashboard.afternoon": "오후",
    "dashboard.evening": "저녁",
    // Chat
    "chat.newConversation": "새 결정 스레드",
    "chat.typeMessage": "결정, 맥락 추적, 다음 수를 물어보세요...",
    "chat.send": "전송",
    // Briefing
    "briefing.learningMode":
      "Jigeum이 처음 2-3일 동안 메일과 일정 패턴을 학습합니다. 사용할수록 핵심 항목이 더 정확해져요.",
    // Common
    "common.loading": "로딩 중...",
    "common.cancel": "취소",
    "common.confirm": "확인",
    "common.delete": "삭제",
    "common.save": "저장",
    "common.or": "또는",
    // Skills
    "skills.title": "스킬",
    "skills.subtitle": "Jigeum이 반복 실행할 수 있는 워크플로우",
    "skills.newSkill": "+ 새 스킬",
    "skills.edit": "스킬 수정",
    "skills.name": "스킬 이름",
    "skills.description": "설명 (선택)",
    "skills.prompt": "프롬프트 템플릿",
    "skills.create": "생성",
    "skills.update": "수정",
    "skills.empty": "아직 저장된 스킬이 없습니다",
    // Approval UX
    "approval.approve": "승인",
    "approval.reject": "거부",
    "approval.alwaysAllow": "항상 허용",
    "approval.neverSuggest": "다시 제안하지 않기",
    // Notifications
    "notif.title": "알림",
    "notif.push": "푸시 알림",
    "notif.preferences": "받을 알림을 선택하세요",
    "notif.quietHours": "방해 금지 시간",
    "notif.quietHoursDesc": "이 시간대에는 푸시 알림을 숨깁니다",
    "notif.categoryEmailUrgent": "긴급 이메일 알림",
    "notif.categoryMeeting": "회의 리마인더",
    "notif.categoryTaskDue": "태스크 마감 임박 및 지연",
    "notif.categoryAgentProposal": "에이전트 제안",
    "notif.categoryDailyBriefing": "일일 브리핑",
  },
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
      console.warn(`[i18n] "${locale}" missing keys: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
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
const PROFILE_KEY = "jigeum-profile";
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
      if (language === "ko") return "ko";
      if (language === "en") return "en";
    }
  } catch {
    // ignore
  }
  // Auto-detect from browser
  if (typeof navigator !== "undefined") {
    const lang = navigator.language || "";
    if (lang.startsWith("ko")) return "ko";
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
