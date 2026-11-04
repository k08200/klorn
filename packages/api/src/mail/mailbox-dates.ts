/**
 * The date a listed mailbox message gets when Gmail gave no way to know it:
 * no internalDate and no parseable Date header. Folder views still list the
 * message (they never hide mail); the Sent scan treats this as "no date" and
 * records nothing (sent-messages.ts toScannedRow).
 */
export const UNKNOWN_DATE = new Date(0);
