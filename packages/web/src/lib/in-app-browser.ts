// Embedded in-app browsers (WebViews opened by chat/social apps) cannot complete
// Google OAuth: Google returns `403: disallowed_useragent` under its "Use secure
// browsers" policy (RFC 8252), which forbids OAuth inside embedded user-agents.
// Korean users hit this constantly because KakaoTalk/Naver/Band open every link
// in their own WebView by default. We detect the common offenders so the login
// page can tell the user to reopen in a real browser *before* they slam into
// Google's wall.
//
// NOTE: This is deliberately NOT the same list as pwa-prompts.tsx. That list
// (CriOS/FxiOS/EdgiOS/GSA) flags browsers that cannot *install a PWA* — but
// Chrome/Firefox on iOS are real browsers where OAuth works fine. Reusing it
// here would show a "reopen in browser" warning to users who don't need it.
// This list is the narrower set of embedded WebViews where OAuth is blocked.

interface InAppBrowserPattern {
  readonly label: string;
  readonly re: RegExp;
}

const IN_APP_BROWSER_PATTERNS: readonly InAppBrowserPattern[] = [
  { label: "KakaoTalk", re: /KAKAOTALK/i },
  { label: "Naver", re: /NAVER\(inapp/i },
  { label: "Band", re: /\bBAND\//i },
  { label: "Daum", re: /DaumApps/i },
  { label: "LINE", re: /\bLine\/[\d.]+/i },
  { label: "Instagram", re: /Instagram/i },
  { label: "Facebook", re: /\b(?:FBAN|FBAV|FB_IAB)\b/ },
  { label: "Threads", re: /\bBarcelona\b/ },
  { label: "WeChat", re: /MicroMessenger/i },
  { label: "TikTok", re: /musical_ly|Bytedance/i },
  { label: "Snapchat", re: /Snapchat/i },
];

/**
 * Returns the name of the embedded in-app browser the user is in (e.g.
 * "KakaoTalk"), or null for a normal browser. Pure: pass `ua` for testing, or
 * omit to read `navigator.userAgent`. Returns null when there is no UA (SSR).
 */
export function detectInAppBrowser(ua?: string | null): string | null {
  const value = ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  if (!value) return null;
  for (const { label, re } of IN_APP_BROWSER_PATTERNS) {
    if (re.test(value)) return label;
  }
  return null;
}

/** True when the user is inside an OAuth-blocking embedded WebView. */
export function isInAppBrowser(ua?: string | null): boolean {
  return detectInAppBrowser(ua) !== null;
}
