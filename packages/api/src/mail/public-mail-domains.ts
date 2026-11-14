/**
 * Public (consumer) mail domains, and an address's organisational domain.
 *
 * A shared domain means an organisation only when it is not a consumer mail
 * provider: millions of strangers share "gmail.com". Used by the interaction
 * graph (importance propagation) and by meeting prep (linking mail to a
 * meeting by the attendee's organisation), so one engaged gmail contact never
 * stands for the whole internet.
 */

/**
 * Consumer mail providers where a shared domain means nothing — millions of
 * strangers share "gmail.com". Propagation is skipped for these so a single
 * engaged gmail contact can't lift trust for the entire internet. Only true
 * organizational domains propagate. Lowercase, exact-match on the domain.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "139.com",
  "sina.com",
  "sohu.com",
  "rediffmail.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "nate.com",
  "kakao.com",
  // Regional consumer variants and ISP mailboxes: as shared as the above.
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "hotmail.es",
  "hotmail.co.jp",
  "outlook.kr",
  "outlook.jp",
  "outlook.fr",
  "outlook.de",
  "live.co.uk",
  "live.fr",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.es",
  "yahoo.it",
  "yahoo.co.kr",
  "yahoo.co.in",
  "yahoo.com.tw",
  "protonmail.ch",
  "tutanota.com",
  "tuta.io",
  "hey.com",
  "foxmail.com",
  "aliyun.com",
  "yeah.net",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "btinternet.com",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "laposte.net",
  "t-online.de",
  "freenet.de",
  "libero.it",
  "nifty.com",
  "docomo.ne.jp",
  "ezweb.ne.jp",
  "softbank.ne.jp",
]);

/**
 * Organizational domain of an address, or null when it's a public mail provider
 * (or unparseable). Only org domains are eligible for importance propagation.
 */
export function orgDomainOf(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const domain = addr
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain.includes(".") || PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}
