/**
 * Surface the API's own error message instead of a fixed UI string.
 *
 * apiFetch throws `API <status>: <raw body>`, and the reading pane was
 * replacing every one of those with a constant. The server had been answering
 * precisely the whole time — a per-user daily cost cap reads
 *
 *   429 {"error":"You've used today's AI quota. It resets at 00:00 UTC.
 *        To unblock right now, add your own API key in Settings."}
 *
 * — but the screen said only "Could not draft a reply.", which is why that
 * failure went undiagnosed for days (reproduced against production 2026-08-12).
 *
 * Falls back whenever the body is not a usable message, so a stack trace, an
 * HTML error page, or a network failure can never land in the UI.
 */

/** Longer than this is a dump, not a sentence meant for a person. */
const MAX_MESSAGE_LENGTH = 300;

export function serverErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;

  const start = err.message.indexOf("{");
  if (start === -1) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(err.message.slice(start));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  const record = parsed as Record<string, unknown>;
  const message = typeof record.error === "string" ? record.error : record.message;
  if (typeof message !== "string") return fallback;

  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) return fallback;
  return trimmed;
}
