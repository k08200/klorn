/**
 * The one server-side gate for a calendar event's meeting link, whatever the
 * provider (Outlook joinUrl, Google conferenceData / hangoutLink, a link lifted
 * from an event description, or one sent to the create route).
 */

/** The longest meeting link kept; a longer value is not a join link, and every client shows it. */
export const MAX_MEETING_LINK_LENGTH = 2048;

/**
 * A meeting link that is safe to hand on: it reaches a web `<a href>`, the Mac
 * app's NSWorkspace.open, the model's prompt and MCP tools, so only an https URL
 * without embedded credentials, of at most 2048 characters, passes. Anything else
 * (javascript:, file:, http:, a custom scheme, a relative, malformed or oversized
 * value, or a value that is not a string) is dropped. Returned normalised.
 */
export function safeMeetingLink(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > MAX_MEETING_LINK_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    // Normalising can lengthen a value (percent-encoding), so the cap holds for the result too.
    return url.href.length <= MAX_MEETING_LINK_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}
