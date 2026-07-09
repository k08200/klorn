"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Locale = "en" | "ko";

// English is the source of truth for keys; Korean is a full mirror (founder
// decision 2026-07-06 reversing the earlier English-only policy — the UI is
// selectable en/ko via Settings → Language).
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
  "nav.decisionQueue": "Decision queue",
  "nav.mail": "Mail",
  "nav.briefing": "Briefing",
  "nav.assistant": "Assistant",
  "nav.admin": "Admin",
  "nav.graph": "Graph",
  "nav.billing": "Plan and billing",
  "nav.workspace": "Workspace",
  "nav.logIn": "Log in",
  "nav.logout": "Log out",
  "nav.home": "Home",
  "nav.earlyAccess": "Early access",
  // Bottom tabs (mobile)
  "tabs.queue": "Queue",
  "tabs.account": "Account",
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
  "auth.welcomeBack": "Welcome back",
  "auth.titleLogin": "Return to your decision queue",
  "auth.titleRegister": "Start with Klorn",
  "auth.descLogin": "Reconnect your work signals and continue where you left off.",
  "auth.descRegister":
    "Connect Gmail and Calendar to turn team signals into evidence-backed decision cards.",
  "auth.inviteOnlyTitle": "Klorn is invite-only.",
  "auth.inviteOnlyBody":
    "Google blocks sign-in until your email is approved as a test user. Request access first — you can sign in the moment you're approved.",
  "auth.requestEarlyAccess": "Request early access",
  "auth.googleApprovedSignIn": "Already approved? Sign in with Google",
  "auth.continueWithGoogle": "Continue with Google",
  "auth.orContinueEmail": "or continue with email",
  "auth.orSignInEmail": "or sign in with email",
  "auth.signUpShort": "Sign up",
  "auth.resetPassword": "Reset password",
  "auth.passwordMin": "At least 8 characters",
  "auth.openDecisionQueue": "Open decision queue",
  "auth.needAccount": "Need an account?",
  "auth.haveAccount": "Already have an account?",
  "auth.switchToSignUp": "Switch to sign-up",
  "auth.switchToLogIn": "Switch to log-in",
  "auth.approvedCantSignIn": "Approved but can't sign in?",
  "auth.resetYourPassword": "Reset your password",
  // Auth — login left panel (aside), doctrine, toasts, deep-link banner
  "auth.asideTitle": "Keep only the work that needs a decision",
  "auth.asideBody":
    "Klorn reads mail, calendar, and task signals, then turns them into cards you can review before anything runs.",
  "auth.stepSignal": "Signal",
  "auth.stepSignalDesc": "Detect meaningful changes in mail and calendar",
  "auth.stepContext": "Context",
  "auth.stepContextDesc": "Connect people, deadlines, and projects",
  "auth.stepApproval": "Approval",
  "auth.stepApprovalDesc": "Review evidence before external execution",
  "auth.betaScope":
    "Free during the private beta. Google flags unverified apps with the restricted Gmail scope until CASA review clears — standard for every Gmail integration.",
  "auth.noSilentActions":
    "What we don't do: send mail without a click-through receipt. Every send, permanent delete, and external forward is hash-bound and verifiable on read.",
  "auth.readDoctrine": "Read the doctrine before the login flow →",
  "auth.openSourceVersion": "Open source · AGPLv3 · v0.3.0",
  "auth.signInToContinue": "Sign in to continue to {destination}.",
  "auth.googleSignInError": "Google sign-in could not be completed. Please try again.",
  "auth.googleUnverified":
    "Google hasn't finished verifying Klorn for your account yet. Approved testers can retry shortly; otherwise request early access.",
  "auth.sessionExpired": "Your session expired. Please sign in again.",
  "auth.inviteOnlyRedirect":
    "Klorn is invite-only right now. Request access from the early access page.",
  "auth.emailVerified": "Email verified. You can sign in now.",
  "auth.passwordMinChars": "Use at least {count} characters.",
  "auth.genericError": "Something went wrong.",
  "auth.formGroupLabel": "Sign in or create an account",
  "auth.destMemory": "Memory settings",
  "auth.destUsage": "Usage settings",
  "auth.destStatus": "System status",
  "auth.destFeedback": "Mail feedback",
  "auth.destFiles": "Files",
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
  "chat.newChat": "New chat",
  "chat.suggestion1": "Summarize my unread mail",
  "chat.suggestion2": "Find the last email from my boss",
  "chat.suggestion3": "What's on my calendar tomorrow?",
  "chat.suggestion4": "내일 3시 김대표 미팅 잡아줘",
  "chat.emptyState":
    "Ask about your mail, calendar, or briefing — or speak with the mic. I work only on your Klorn data.",
  "chat.loadingConversation": "Loading conversation…",
  "chat.inputPlaceholder": "Ask about your mail or calendar…",
  "chat.thinking": "Thinking…",
  "chat.sendFailed": "Could not send your message — it's back in the input box. Try again.",
  // Calendar event draft card
  "draft.title": "Calendar event draft",
  "draft.save": "Save to calendar",
  "draft.saving": "Saving…",
  "draft.saved": "Saved to your calendar ✓",
  "draft.paywall": "Saving events needs a Pro plan.",
  "draft.seePlans": "See plans",
  "draft.error": "Could not save the event. Please try again.",
  // Mail
  "mail.filterAll": "All signals",
  "mail.filterReplyNeeded": "Needs reply",
  "mail.filterUrgent": "Urgent",
  "mail.filterUnread": "Unread",
  "mail.filterAttachments": "Attachments",
  "mail.filterCandidates": "Candidates",
  "mail.filterThreads": "Threads",
  "mail.filterAutomated": "Automated",
  "mail.compose": "Compose",
  "mail.searchMail": "Search mail",
  "mail.searchPlaceholder": "Search mail, attachments, fields",
  "mail.emptyReplyTitle": "Nothing needs a reply",
  "mail.emptyTitle": "No mail here",
  "mail.emptyDemoBody": "Connect Gmail in Settings so Klorn can sort your real mail.",
  "mail.emptyBody": "When Klorn finds mail that needs you, it rises to the top.",
  "mail.emptyAll": "No mail signals yet.",
  "mail.emptyReplyNow": "Nothing needs a reply right now.",
  "mail.emptyFilter": "No signals match this filter.",
  "mail.emptyReplyHint":
    "Switch tabs to see urgent, unread, or all mail — Klorn promotes a thread here when it detects something you should answer.",
  "mail.emptySyncHint": "After sync, mail that needs action rises to the top.",
  "mail.showAllSignals": "Show all signals",
  "mail.connectGoogle": "Connect Google",
  // Calendar
  "calendar.newEvent": "New event",
  "calendar.needPrep": "Meetings that need prep",
  "calendar.voiceParsing": "Understanding your event…",
  // Decision queue (inbox)
  "inbox.decisions": "Decisions",
  "inbox.tracking": "Tracking",
  "inbox.allClear": "All clear",
  "inbox.nothingNeedsYou": "Nothing needs you right now",
  "inbox.nothingToDecide": "Nothing to decide",
  "inbox.nothingToDecideToday": "Nothing to decide today.",
  "inbox.emptyBody":
    "Klorn is watching your mail and calendar. When something needs a decision, it lands here.",
  "inbox.emptyBodyMobile": "Klorn is watching your mail and calendar. New decisions land here.",
  "inbox.openMail": "Open mail",
  "inbox.tourTitle": "New here? 30-second tour",
  // Briefing
  "briefing.learningMode":
    "Klorn learns mail and calendar patterns during the first 2-3 days. The top actions get sharper as you use the workspace.",
  "briefing.heading": "Today's decision brief",
  "briefing.notGenerated": "Not generated yet",
  "briefing.generate": "Generate",
  "briefing.generateNow": "Generate now",
  "briefing.generating": "Generating...",
  "briefing.regenerate": "Regenerate",
  // Common
  "common.loading": "Loading...",
  "common.syncNow": "Sync now",
  "common.syncing": "Syncing...",
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

const koTranslations: Record<string, string> = {
  // Nav
  "nav.dashboard": "대시보드",
  "nav.chat": "챗",
  "nav.email": "메일",
  "nav.calendar": "캘린더",
  "nav.tasks": "할 일",
  "nav.notes": "노트",
  "nav.contacts": "연락처",
  "nav.reminders": "리마인더",
  "nav.auto": "자동",
  "nav.decisionQueue": "결정 큐",
  "nav.mail": "메일",
  "nav.briefing": "브리핑",
  "nav.assistant": "어시스턴트",
  "nav.admin": "관리자",
  "nav.graph": "그래프",
  "nav.billing": "플랜 및 결제",
  "nav.workspace": "워크스페이스",
  "nav.logIn": "로그인",
  "nav.logout": "로그아웃",
  "nav.home": "홈",
  "nav.earlyAccess": "얼리 액세스",
  // Bottom tabs (mobile)
  "tabs.queue": "큐",
  "tabs.account": "계정",
  // Auth
  "auth.signIn": "로그인",
  "auth.signUp": "계정 만들기",
  "auth.signingIn": "로그인 중...",
  "auth.creatingAccount": "계정 생성 중...",
  "auth.email": "이메일",
  "auth.password": "비밀번호",
  "auth.name": "이름",
  "auth.noAccount": "계정이 없으신가요? 가입하기",
  "auth.hasAccount": "이미 계정이 있으신가요? 로그인",
  "auth.backHome": "홈으로 돌아가기",
  "auth.welcome": "다시 만나서 반가워요!",
  "auth.accountCreated": "계정이 생성되었습니다!",
  "auth.welcomeBack": "다시 오신 것을 환영해요",
  "auth.titleLogin": "결정 큐로 돌아가세요",
  "auth.titleRegister": "Klorn 시작하기",
  "auth.descLogin": "업무 신호를 다시 연결하고 하던 곳에서 이어가세요.",
  "auth.descRegister": "Gmail과 캘린더를 연결해 팀 신호를 근거 기반 결정 카드로 바꿔보세요.",
  "auth.inviteOnlyTitle": "Klorn은 현재 초대 전용입니다.",
  "auth.inviteOnlyBody":
    "테스트 사용자로 승인되기 전까지는 Google 로그인이 차단됩니다. 먼저 액세스를 요청하세요 — 승인되는 즉시 로그인할 수 있어요.",
  "auth.requestEarlyAccess": "얼리 액세스 요청",
  "auth.googleApprovedSignIn": "이미 승인되셨나요? Google로 로그인",
  "auth.continueWithGoogle": "Google로 계속하기",
  "auth.orContinueEmail": "또는 이메일로 계속하기",
  "auth.orSignInEmail": "또는 이메일로 로그인",
  "auth.signUpShort": "가입하기",
  "auth.resetPassword": "비밀번호 재설정",
  "auth.passwordMin": "8자 이상",
  "auth.openDecisionQueue": "결정 큐 열기",
  "auth.needAccount": "계정이 필요하신가요?",
  "auth.haveAccount": "이미 계정이 있으신가요?",
  "auth.switchToSignUp": "가입으로 전환",
  "auth.switchToLogIn": "로그인으로 전환",
  "auth.approvedCantSignIn": "승인됐는데 로그인이 안 되나요?",
  "auth.resetYourPassword": "비밀번호를 재설정하세요",
  // Auth — 로그인 좌측 패널, 도크트린, 토스트, 딥링크 배너
  "auth.asideTitle": "결정이 필요한 일만 남기세요",
  "auth.asideBody":
    "Klorn이 메일·캘린더·업무 신호를 읽어, 무엇이든 실행되기 전에 검토할 수 있는 카드로 만들어 줍니다.",
  "auth.stepSignal": "신호",
  "auth.stepSignalDesc": "메일과 캘린더의 의미 있는 변화를 감지합니다",
  "auth.stepContext": "컨텍스트",
  "auth.stepContextDesc": "사람·마감·프로젝트를 연결합니다",
  "auth.stepApproval": "승인",
  "auth.stepApprovalDesc": "외부 실행 전에 근거를 검토합니다",
  "auth.betaScope":
    "비공개 베타 기간 동안 무료입니다. Google은 CASA 심사가 끝날 때까지 제한된 Gmail 범위를 사용하는 미검증 앱을 표시하며, 이는 모든 Gmail 연동에 적용되는 표준 절차입니다.",
  "auth.noSilentActions":
    "저희가 하지 않는 것: 클릭 확인 없이 메일을 보내지 않습니다. 모든 발송·영구 삭제·외부 전달은 해시로 묶여 있어 열람 시 검증할 수 있습니다.",
  "auth.readDoctrine": "로그인 전에 설계 원칙 읽기 →",
  "auth.openSourceVersion": "오픈소스 · AGPLv3 · v0.3.0",
  "auth.signInToContinue": "{destination}(으)로 이어가려면 로그인하세요.",
  "auth.googleSignInError": "Google 로그인을 완료하지 못했습니다. 다시 시도해 주세요.",
  "auth.googleUnverified":
    "Google이 아직 회원님 계정에 대한 Klorn 검증을 마치지 않았습니다. 승인된 테스터는 잠시 후 다시 시도할 수 있으며, 그 외에는 얼리 액세스를 신청해 주세요.",
  "auth.sessionExpired": "세션이 만료되었습니다. 다시 로그인해 주세요.",
  "auth.inviteOnlyRedirect":
    "Klorn은 현재 초대 전용입니다. 얼리 액세스 페이지에서 액세스를 신청해 주세요.",
  "auth.emailVerified": "이메일이 확인되었습니다. 이제 로그인할 수 있어요.",
  "auth.passwordMinChars": "최소 {count}자 이상 입력해 주세요.",
  "auth.genericError": "문제가 발생했습니다.",
  "auth.formGroupLabel": "로그인 또는 계정 만들기",
  "auth.destMemory": "메모리 설정",
  "auth.destUsage": "사용량 설정",
  "auth.destStatus": "시스템 상태",
  "auth.destFeedback": "메일 피드백",
  "auth.destFiles": "파일",
  // Settings
  "settings.title": "설정",
  "settings.subtitle": "프로필, 연동, 환경설정을 관리하세요",
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
  "settings.envVars": "환경변수를 설정하면 활성화됩니다",
  "settings.quickActions": "빠른 작업",
  "settings.dailyBriefing": "데일리 브리핑",
  "settings.generateNow": "지금 생성",
  "settings.capabilities": "Decision OS 표면",
  "settings.data": "데이터",
  "settings.exportData": "데이터 내보내기",
  "settings.export": "내보내기",
  "settings.dangerZone": "위험 구역",
  "settings.deleteAll": "모든 데이터 삭제",
  "settings.deleteBtn": "전체 삭제",
  "settings.about": "정보",
  // Dashboard
  "dashboard.greeting": "좋은 {timeOfDay}입니다, {name}님",
  "dashboard.morning": "아침",
  "dashboard.afternoon": "오후",
  "dashboard.evening": "저녁",
  // Chat
  "chat.newConversation": "새 결정 스레드",
  "chat.typeMessage": "결정, 맥락 추적, 다음 액션을 물어보세요...",
  "chat.send": "보내기",
  "chat.newChat": "새 대화",
  "chat.suggestion1": "안 읽은 메일 요약해줘",
  "chat.suggestion2": "상사에게 온 마지막 메일 찾아줘",
  "chat.suggestion3": "내일 내 일정 뭐가 있지?",
  "chat.suggestion4": "내일 3시 김대표 미팅 잡아줘",
  "chat.emptyState":
    "메일, 캘린더, 브리핑에 대해 물어보거나 마이크로 말해보세요. Klorn 데이터 안에서만 동작해요.",
  "chat.loadingConversation": "대화를 불러오는 중…",
  "chat.inputPlaceholder": "메일이나 캘린더에 대해 물어보세요…",
  "chat.thinking": "생각 중…",
  "chat.sendFailed": "메시지를 보내지 못했어요 — 입력창에 다시 넣어두었으니 다시 시도해주세요.",
  // Calendar event draft card
  "draft.title": "캘린더 일정 초안",
  "draft.save": "캘린더에 저장",
  "draft.saving": "저장 중…",
  "draft.saved": "캘린더에 저장했어요 ✓",
  "draft.paywall": "일정 저장에는 Pro 플랜이 필요해요.",
  "draft.seePlans": "플랜 보기",
  "draft.error": "일정을 저장하지 못했어요. 다시 시도해주세요.",
  // Mail
  "mail.filterAll": "모든 신호",
  "mail.filterReplyNeeded": "답장 필요",
  "mail.filterUrgent": "긴급",
  "mail.filterUnread": "안 읽음",
  "mail.filterAttachments": "첨부",
  "mail.filterCandidates": "후보",
  "mail.filterThreads": "스레드",
  "mail.filterAutomated": "자동 메일",
  "mail.compose": "메일 쓰기",
  "mail.searchMail": "메일 검색",
  "mail.searchPlaceholder": "메일, 첨부, 항목 검색",
  "mail.emptyReplyTitle": "답장할 메일이 없어요",
  "mail.emptyTitle": "여기엔 메일이 없어요",
  "mail.emptyDemoBody": "설정에서 Gmail을 연결하면 Klorn이 실제 메일을 정리해드려요.",
  "mail.emptyBody": "당신의 손이 필요한 메일을 찾으면 맨 위로 올려드려요.",
  "mail.emptyAll": "아직 메일 신호가 없어요.",
  "mail.emptyReplyNow": "지금은 답장할 메일이 없어요.",
  "mail.emptyFilter": "이 필터에 맞는 신호가 없어요.",
  "mail.emptyReplyHint":
    "긴급, 안 읽음, 전체 메일은 다른 탭에서 볼 수 있어요 — 답해야 할 메일을 감지하면 Klorn이 스레드를 여기로 올려드려요.",
  "mail.emptySyncHint": "동기화하면 조치가 필요한 메일이 맨 위로 올라와요.",
  "mail.showAllSignals": "모든 신호 보기",
  "mail.connectGoogle": "Google 연결",
  // Calendar
  "calendar.newEvent": "새 일정",
  "calendar.needPrep": "준비가 필요한 미팅",
  "calendar.voiceParsing": "일정을 파악하는 중…",
  // Decision queue (inbox)
  "inbox.decisions": "결정",
  "inbox.tracking": "추적 중",
  "inbox.allClear": "모두 정리됨",
  "inbox.nothingNeedsYou": "지금은 처리할 일이 없어요",
  "inbox.nothingToDecide": "결정할 것이 없어요",
  "inbox.nothingToDecideToday": "오늘은 결정할 것이 없어요.",
  "inbox.emptyBody":
    "Klorn이 메일과 캘린더를 지켜보고 있어요. 결정이 필요한 일이 생기면 여기로 올라옵니다.",
  "inbox.emptyBodyMobile": "Klorn이 메일과 캘린더를 지켜보고 있어요. 새 결정은 여기에 표시됩니다.",
  "inbox.openMail": "메일 열기",
  "inbox.tourTitle": "처음이신가요? 30초 투어",
  // Briefing
  "briefing.learningMode":
    "Klorn은 처음 2-3일 동안 메일과 캘린더 패턴을 학습합니다. 쓸수록 핵심 액션이 더 정확해집니다.",
  "briefing.heading": "오늘의 결정 브리핑",
  "briefing.notGenerated": "아직 생성되지 않았어요",
  "briefing.generate": "생성",
  "briefing.generateNow": "지금 생성",
  "briefing.generating": "생성 중...",
  "briefing.regenerate": "다시 생성",
  // Common
  "common.loading": "불러오는 중...",
  "common.syncNow": "지금 동기화",
  "common.syncing": "동기화 중...",
  "common.cancel": "취소",
  "common.confirm": "확인",
  "common.delete": "삭제",
  "common.save": "저장",
  "common.or": "또는",
  // Skills
  "skills.title": "스킬",
  "skills.subtitle": "Klorn이 대신 실행하는 재사용 워크플로",
  "skills.newSkill": "+ 새 스킬",
  "skills.edit": "스킬 편집",
  "skills.name": "스킬 이름",
  "skills.description": "설명 (선택)",
  "skills.prompt": "프롬프트 템플릿",
  "skills.create": "만들기",
  "skills.update": "업데이트",
  "skills.empty": "아직 스킬이 없습니다",
  // Approval UX
  "approval.approve": "승인",
  "approval.reject": "거절",
  "approval.alwaysAllow": "항상 허용",
  "approval.neverSuggest": "다시 제안하지 않기",
  // Notifications
  "notif.title": "알림",
  "notif.push": "푸시 알림",
  "notif.preferences": "어떤 알림을 받을까요?",
  "notif.quietHours": "방해 금지 시간",
  "notif.quietHoursDesc": "이 시간 동안 푸시 알림을 보내지 않습니다",
  "notif.categoryEmailUrgent": "긴급 메일 알림",
  "notif.categoryMeeting": "미팅 리마인더",
  "notif.categoryTaskDue": "임박·기한 초과 할 일",
  "notif.categoryAgentProposal": "에이전트 제안",
  "notif.categoryDailyBriefing": "데일리 브리핑",
};

const translations: Record<Locale, Record<string, string>> = {
  en: enTranslations,
  ko: koTranslations,
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
  // English is the default. Korean is opt-in only — a Korean-locale browser
  // still lands in English unless the user explicitly picks 한국어 in
  // Settings → Language. We intentionally do NOT follow navigator.language.
  try {
    const stored = getStoredProfile();
    if (stored) {
      const { language } = JSON.parse(stored);
      if (language === "ko") return "ko";
    }
  } catch {
    // ignore a malformed profile
  }
  return "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    setLocaleState(detectLocale());

    // Re-detect when profile settings change in another tab/window…
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROFILE_KEY || e.key === LEGACY_PROFILE_KEY) {
        setLocaleState(detectLocale());
      }
    };
    // …and in THIS tab (the storage event never fires in the writing tab, so
    // Settings dispatches this after saving the profile).
    const onProfileUpdated = () => setLocaleState(detectLocale());
    window.addEventListener("storage", onStorage);
    window.addEventListener("klorn-profile-updated", onProfileUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("klorn-profile-updated", onProfileUpdated);
    };
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
