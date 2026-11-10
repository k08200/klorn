/**
 * Public mailbox providers — domains where the domain says nothing about the
 * sender. A domain-wide tier pin on one of these would pin every stranger
 * who happens to mail from it, so BOTH the pin write path and the judge's
 * read path (fetchPinnedTier) refuse them: the generic /api/email/rules
 * endpoint can author arbitrary PIN_TIER rows, so a write-side guard alone
 * is advisory, not an invariant. Deliberately short.
 */

const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "kakao.com",
  "qq.com",
  "163.com",
  "126.com",
]);

/** `domain` must already be lowercased (both call sites lowercase upstream). */
export function isPublicMailboxDomain(domain: string): boolean {
  return PUBLIC_MAILBOX_DOMAINS.has(domain);
}
