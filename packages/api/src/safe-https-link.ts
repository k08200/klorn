/**
 * The one rule for a link Klorn stores or hands on, whatever it points at: a
 * calendar event's meeting link (pim/meeting-link.ts), a drive file's link
 * (drive/drive-rows.ts, drive/drive-read.ts).
 */

/** The longest link kept; every client shows it, and a longer value is not one a person opens. */
export const MAX_HTTPS_LINK_LENGTH = 2048;

/**
 * A link that is safe to hand on: it reaches a web `<a href>`, the Mac app's
 * NSWorkspace.open, the model's prompt and MCP tools, so only an https URL
 * without embedded credentials, of at most 2048 characters, passes. Anything else
 * (javascript:, file:, http:, a custom scheme, a relative, malformed or oversized
 * value, or a value that is not a string) is dropped. Returned normalised.
 */
export function safeHttpsLink(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > MAX_HTTPS_LINK_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    // Normalising can lengthen a value (percent-encoding), so the cap holds for the result too.
    return url.href.length <= MAX_HTTPS_LINK_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}
