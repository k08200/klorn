/**
 * Connect failures the server answers with a stable code and a static English
 * sentence (api: mail/imap-verify-failure.ts). The web shows its own localized
 * generic sentence for these instead of the thrown "API 400: {json}" text.
 */
const GENERIC_VERIFY_CODES = ["IMAP_VERIFY_FAILED", "IMAP_UNREACHABLE"] as const;

export function isGenericImapVerifyFailure(message: string): boolean {
  if (!message.startsWith("API 400")) return false;
  return GENERIC_VERIFY_CODES.some((code) => message.includes(`"code":"${code}"`));
}
