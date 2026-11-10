import crypto from "node:crypto";

/**
 * The confirmation step of the desktop POLL sign-in (`source=desktop` with no
 * app scheme: the Windows wrapper's flow, and the Mac app's fallback when the
 * browser blocks the klorn:// launch).
 *
 * That flow parks the session for whoever polls /desktop-token/:nonce with the
 * nonce's PKCE verifier. PKCE stops someone who only sees the nonce, not
 * someone who minted it: an attacker could start a desktop sign-in, send the
 * victim the login link, and poll the victim's session out once the victim
 * signed in (with an existing Google consent, a single click). The browser and
 * the app are not connected, so the browser is asked: it shows a pairing code
 * derived from the nonce, the app shows the same code, and nothing is parked
 * until the person in the browser confirms. This is the device-flow check;
 * the deep-link relay needs none, because its session reaches only the app on
 * the device that signed in.
 */

const CONFIRM_TTL_MS = 5 * 60_000;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const confirmations = new Map<string, { nonce: string; jwt: string; expiresAt: number }>();

/**
 * The code both sides show: the first 40 bits of SHA-256(nonce) in Crockford
 * base32 (no I, L, O or U), as XXXX-XXXX. Web lib/native/native-auth.ts and the
 * Mac app compute the same from the nonce they hold.
 */
export function pairingCode(nonce: string): string {
  const digest = crypto.createHash("sha256").update(nonce).digest();
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(digest[i] ?? 0);
  let code = "";
  for (let shift = 35n; shift >= 0n; shift -= 5n) {
    code += CROCKFORD_BASE32[Number((bits >> shift) & 31n)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Hold a finished sign-in until its browser confirms it; returns the confirmation id. */
export function beginDesktopConfirmation(nonce: string, jwt: string): string {
  const id = crypto.randomBytes(20).toString("hex");
  confirmations.set(id, { nonce, jwt, expiresAt: Date.now() + CONFIRM_TTL_MS });
  const timer = setTimeout(() => confirmations.delete(id), CONFIRM_TTL_MS);
  timer.unref?.();
  return id;
}

/** The held sign-in for this id, once; null when unknown, used or expired. */
export function takeDesktopConfirmation(id: unknown): { nonce: string; jwt: string } | null {
  if (typeof id !== "string") return null;
  const pending = confirmations.get(id);
  if (!pending) return null;
  confirmations.delete(id);
  if (pending.expiresAt < Date.now()) return null;
  return { nonce: pending.nonce, jwt: pending.jwt };
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PAGE_STYLE = `body{font-family:system-ui;background:#0a0a0a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:40px;max-width:440px}
.t{font-size:14px;color:#9ca3af;margin-top:12px;line-height:1.6}
.code{font:600 28px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.12em;margin:20px 0 4px}
.warn{font-size:13px;color:#fbbf24;margin-top:16px;line-height:1.6}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:24px;padding:0 20px;border:0;border-radius:8px;background:#e5e7eb;color:#0a0a0a;font-size:14px;font-weight:600;cursor:pointer}
.btn:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}`;

/**
 * The browser's confirmation page: the pairing code and one button that POSTs
 * the id. No script (the API's HTML CSP blocks it anyway) and no framing (the
 * global X-Frame-Options / frame-ancestors), so the click cannot be forged by
 * another page.
 */
export function desktopConfirmPage(confirmId: string, code: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in to the Klorn app?</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${PAGE_STYLE}</style>
</head><body><div class="box">
<h2>Sign in to the Klorn app?</h2>
<p class="t">You signed in here to finish signing in to the Klorn desktop app. The app shows this code:</p>
<div class="code">${escapeHtml(code)}</div>
<p class="warn">Continue only if you started signing in from the Klorn app on this computer just now and its code matches. If you did not, close this page: someone may be trying to get into your account.</p>
<form method="post" action="/api/auth/desktop-confirm">
<input type="hidden" name="confirm" value="${escapeHtml(confirmId)}">
<button class="btn" type="submit">Sign in the app</button>
</form>
</div></body></html>`;
}

/** What the confirm endpoint answers when the id is unknown, used or expired. */
export function desktopConfirmExpiredPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in expired</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${PAGE_STYLE}</style>
</head><body><div class="box">
<h2>This sign-in expired</h2>
<p class="t">Start signing in again from the Klorn app.<br>You can close this tab.</p>
</div></body></html>`;
}
