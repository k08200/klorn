/**
 * TwiML builders + sanitization for phone escalation v0.
 *
 * Pure string functions; no DB, no Twilio client. Split out of
 * phone-escalation.ts so routes/phone.ts can rebuild the gather prompt
 * without importing the dialing module (and its sms-phone/db deps).
 *
 * SECURITY: the spoken title is untrusted email content read aloud over a
 * phone line. Two layers:
 *   1. sanitizeTitleForSpeech — allowlist of speakable characters; strips
 *      URL-like tokens (a TTS voice reading "h t t p s colon slash slash
 *      evil dot com" is a phishing vector) and anything XML-shaped.
 *   2. escapeXml — every interpolation point is escaped, so even a title
 *      that survives the allowlist can never break out of <Say> into
 *      <Dial>/<Redirect>/<Sms> verbs.
 */

/** Spoken titles are clipped — a phone call is a headline, not a reader. */
const MAX_SPOKEN_TITLE_CHARS = 140;
/** Seconds the <Gather> waits for a keypress before giving up. */
const GATHER_TIMEOUT_SECONDS = 10;

const URL_LIKE_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
/** Allowlist: letters/digits/whitespace + tame punctuation. Everything else
 * (angle brackets, slashes, backticks, control chars, emoji) becomes a space. */
const UNSAFE_CHAR_PATTERN = /[^\p{L}\p{N}\s.,:;!?'"()@&%+-]/gu;

/** Generic phrase spoken when sanitization leaves nothing usable. */
export const FALLBACK_SPOKEN_TITLE = "an item that needs your attention";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Reduce an untrusted email subject to something safe to speak aloud:
 * URLs gone, non-allowlisted characters gone, whitespace collapsed,
 * length capped. Returns "" when nothing speakable remains.
 */
export function sanitizeTitleForSpeech(title: string): string {
  const stripped = title
    .replace(URL_LIKE_PATTERN, " ")
    .replace(UNSAFE_CHAR_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= MAX_SPOKEN_TITLE_CHARS) return stripped;
  return stripped.slice(0, MAX_SPOKEN_TITLE_CHARS).trim();
}

/**
 * The full escalation prompt: <Say> + <Gather numDigits=1>. `spokenTitle`
 * must already be sanitized (it is escaped again here regardless).
 */
export function buildEscalationTwiml(spokenTitle: string, gatherActionUrl: string): string {
  const prompt = escapeXml(
    `Klorn here. You have an urgent item: ${spokenTitle || FALLBACK_SPOKEN_TITLE}. ` +
      `Press 1 to hear it again, press 2 to acknowledge.`,
  );
  const action = escapeXml(gatherActionUrl);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Gather numDigits="1" action="${action}" method="POST" timeout="${GATHER_TIMEOUT_SECONDS}">` +
    `<Say>${prompt}</Say>` +
    `</Gather>` +
    `<Say>No input received. Goodbye.</Say>` +
    `</Response>`
  );
}

/** A terminal <Say> + <Hangup/> response (ack confirmation, goodbye). */
export function buildSayHangupTwiml(message: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`
  );
}

/**
 * Public base URL of this API — where Twilio must be able to reach the
 * gather/status webhooks. PUBLIC_URL wins; RENDER_EXTERNAL_URL keeps the
 * hosted deployment working without an extra env. Null disables calling.
 */
export function publicBaseUrl(): string | null {
  const raw = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed || null;
}
