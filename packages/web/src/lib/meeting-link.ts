// A calendar event's meetingLink is attacker-controlled: anyone can send an
// invite, and the server takes the link from the event's conference data or a
// regex over its description. React 19 blocks `javascript:` in href, but not
// `data:`, `file:` or app schemes (`zoommtg:`, `msteams:`), so the client
// decides what it will open. Only an absolute https URL with no userinfo
// passes; anything else is shown as text, never as a link.
//
// Pure and import-free: pinned by packages/api/src/__tests__/web-meeting-link.test.ts
// (the web package has no unit-test runner). Mirror of MeetingLink.safeURL in
// apps/desktop-mac/Sources/KlornMac/MeetingCardSupport.swift.

const SAFE_PROTOCOL = "https:";
// ASCII space and every control character below it, plus DEL.
const LAST_SPACE_OR_CONTROL = 0x20;
const DELETE = 0x7f;

// The URL parser silently strips or repairs whitespace and control characters,
// so input carrying any of them is refused, not cleaned up.
function hasWhitespaceOrControl(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= LAST_SPACE_OR_CONTROL || code === DELETE) return true;
  }
  return false;
}

/** The href to open for a meeting link, or null when it must not be opened. */
export function safeMeetingHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (hasWhitespaceOrControl(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== SAFE_PROTOCOL) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  return url.href;
}
