/**
 * The native-app leg of an OAuth flow: which custom schemes may receive a
 * deep link, and the page that hands the browser over to the app. Shared by
 * the login callbacks (routes/auth.ts, routes/social-auth.ts) and the
 * account-link callbacks (routes/link-handoff.ts), so a link flow can reach the
 * app without importing the whole auth route module.
 */

// Allowlisted native app URL schemes for the OAuth deep-link relay. The token is
// delivered by redirecting the browser to `<scheme>://oauth-callback?code=…`,
// which the OS routes to the app holding that scheme on the user's OWN device —
// so an attacker who merely knows a login nonce cannot receive the token (it is
// never parked in a pollable server slot). Only these fixed schemes are valid
// targets, so an attacker cannot redirect the token to a scheme they control.
// Configurable so a new build's scheme can be added without a code change.
const NATIVE_OAUTH_SCHEMES = (process.env.NATIVE_OAUTH_SCHEMES ?? "ai.klorn.app,klorn")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isAllowedNativeScheme(scheme: unknown): scheme is string {
  return typeof scheme === "string" && NATIVE_OAUTH_SCHEMES.includes(scheme);
}

/** The fixed words of a handoff page. Constants only: never user input. */
export interface HandoffCopy {
  readonly title: string;
  readonly heading: string;
  /** May carry a literal `<br>`. */
  readonly body: string;
}

const LOGIN_HANDOFF_COPY: HandoffCopy = {
  title: "Klorn Login",
  heading: "Login Successful",
  body: "Klorn Desktop is finishing sign-in.<br>You can close this tab.",
};

/** An account-link flow handing its parked handle to the app. */
export const LINK_HANDOFF_COPY: HandoffCopy = {
  title: "Klorn",
  heading: "Almost done",
  body: "Klorn is finishing connecting your account.<br>You can close this tab.",
};

// The desktop browser leg must END IN A DOCUMENT. A bare 302 whose Location is
// a custom scheme hands the URL to the OS (the app does launch and sign-in DOES
// succeed) but commits nothing, so the tab keeps rendering whatever was last
// committed — Google's account chooser — and spins forever. Dogfood 2026-08-10:
// "로그인 누르면 무한로딩, 탭을 직접 끄면 로그인이 되어 있다".
//
// Serving a page fixes both halves of that: the document commits (so the
// spinner ends no matter what the OS does with the scheme), and the launch is
// retried from that document.
//
// The automatic launch is a <meta http-equiv="refresh">, NOT a script: every
// HTML response from this API is served under `default-src 'none'; style-src
// 'unsafe-inline'` (see the onSend hook in index.ts), so script-src is 'none'
// and an inline <script> would silently never run. A meta refresh is not
// governed by CSP, so the handoff survives the policy instead of quietly
// depending on relaxing it. The anchor is the second half: browsers that only
// honor an external-protocol launch on a user gesture still get one click away.
//
// window.close() is deliberately absent — it is script (blocked) and would be a
// no-op regardless, since a tab the desktop app opened was not opened by
// script. The "you can close this tab" copy is the real guarantee.
//
// The deep link is escaped for the attribute even though it cannot currently
// carry a metacharacter (its scheme passed isAllowedNativeScheme and its code
// is hex from crypto.randomBytes): NATIVE_OAUTH_SCHEMES is env-configurable, so
// a self-hoster's typo must not be able to become markup.
export function desktopHandoffPage(
  deepLink: string,
  copy: HandoffCopy = LOGIN_HANDOFF_COPY,
): string {
  const href = deepLink
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${copy.title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${href}">
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px;max-width:420px}.ok{font-size:48px;margin-bottom:16px}
.t{font-size:14px;color:#9ca3af;margin-top:12px;line-height:1.6}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:24px;padding:0 20px;border-radius:8px;background:#e5e7eb;color:#0a0a0a;font-size:14px;font-weight:600;text-decoration:none}
.btn:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}</style>
</head><body><div class="box"><div class="ok" aria-hidden="true">✓</div>
<h2>${copy.heading}</h2>
<p class="t">${copy.body}</p>
<a class="btn" href="${href}">Open Klorn</a>
</div></body></html>`;
}
