/**
 * Where the daily digest's opt-out points, and what it is called.
 *
 * Split out of email.ts for one reason: the URL is built from an env var, and
 * a bad env var must not be able to put a malformed URI into a mail header or
 * quietly drop the opt-out. That is testable only if the base URL is an
 * argument rather than module state read at import time.
 *
 * The target is the existing `notifyDailyBriefing` preference the digest sweep
 * itself gates on (notify/notification-prefs.ts, category `daily_briefing`),
 * anchored to that checkbox in the settings UI. Not a parallel suppression
 * list: a second store of "who said no" is a second thing that can disagree
 * with the settings screen, and the one the user can see has to win.
 */

const DIGEST_UNSUBSCRIBE_PATH = "/settings/notifications#notifyDailyBriefing";

/**
 * Normalize an operator-supplied base URL down to its origin and append the
 * preferences path. Returns null when the value cannot be trusted as a target.
 *
 * `new URL(...).origin` is doing the real work. Validating the raw string and
 * then returning *that string* (the shape of this file's older sibling,
 * `safeHttpUrl`) lets a surprising amount through, because `new URL` tolerates
 * far more than it round-trips: embedded CR/LF/TAB are stripped during parsing,
 * so a value carrying them passes the check and comes back out still carrying
 * them. Taking `.origin` discards userinfo, path, query and fragment and
 * re-serializes from parsed parts, so the result cannot contain a `>` or a `,`
 * that would split one List-Unsubscribe URI into two, cannot smuggle control
 * characters into a header, and cannot produce `https://app@evil.example`.
 */
export function digestUnsubscribeUrl(baseUrl: string | undefined | null): string | null {
  const raw = (baseUrl || "").trim();
  if (!raw) return null;
  let origin: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  // "null" is what URL.origin yields for an opaque origin; never a mail target.
  if (!origin || origin === "null") return null;
  return `${origin}${DIGEST_UNSUBSCRIBE_PATH}`;
}

/**
 * en/ko only, every other ship language falling back to English — the same rule
 * the digest body itself follows (pim/daily-digest.ts). Inventing five more
 * sets of unreviewed legal-adjacent copy is worse than an honest fallback.
 *
 * The label names the preference, not just this mail, because that preference
 * also governs the morning briefing and the weekly report (pim/briefing.ts,
 * pim/weekly-report.ts). Calling it "unsubscribe from the daily digest" would
 * promise a narrower effect than the switch actually has.
 */
const LABEL: Record<"en" | "ko", string> = {
  en: "Unsubscribe — turn off daily briefing emails and alerts",
  ko: "수신거부 — 데일리 브리핑 메일·알림 끄기",
};

export function digestUnsubscribeLabel(language: string): string {
  return language === "ko" ? LABEL.ko : LABEL.en;
}
