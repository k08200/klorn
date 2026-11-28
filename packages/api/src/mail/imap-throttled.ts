/**
 * imapflow's code for a command the server throttled (Microsoft 365 answers
 * "Request is throttled. Suggested Backoff Time: N" with a BAD). Its own module
 * so tests that mock providers/imap-session.ts still get it.
 */
export const IMAP_THROTTLED_CODE = "ETHROTTLE";
