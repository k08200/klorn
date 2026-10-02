/**
 * Shared fixtures for the B2 move tests: the two mailboxes, the account and mail
 * rows a poll would have stored, and a helper that delivers one message to the
 * fake server AND the local table consistently (same subject, same date, same
 * UID in the id), which is the state every move starts from.
 */

import { createFakeDb, type FakeDb, type Row } from "./fake-db.js";
import { fakeServer, type NewMessage } from "./fake-imap-server.js";

export const USER = "u1";

export interface Mailbox {
  rowId: string;
  provider: "NAVER" | "ICLOUD" | "IMAP";
  email: string;
  idPrefix: string;
  host: string;
}

export const NAVER: Mailbox = {
  rowId: "row-1",
  provider: "NAVER",
  email: "me@naver.com",
  idPrefix: "naver-imap",
  host: "imap.naver.com:993",
};

export const ICLOUD: Mailbox = {
  rowId: "row-2",
  provider: "ICLOUD",
  email: "me@icloud.com",
  idPrefix: "icloud-imap",
  host: "imap.mail.me.com:993",
};

/** A generic IMAP mailbox (step B4): a user-supplied host, ids under `generic-imap:`. */
export const GENERIC: Mailbox = {
  rowId: "row-3",
  provider: "IMAP",
  email: "me@example.com",
  idPrefix: "generic-imap",
  host: "imap.example.com:993",
};

export const idOf = (mailbox: Mailbox, uid: number): string =>
  `${mailbox.idPrefix}:${mailbox.email}:${uid}`;

/** The INBOX UIDVALIDITY the fake server starts with, and so what a poll would have stored. */
export const INBOX_VALIDITY = "1000";

export function accountRow(
  mailbox: Mailbox,
  inboxUidValidity: string | null = INBOX_VALIDITY,
): Row {
  return {
    id: mailbox.rowId,
    userId: USER,
    provider: mailbox.provider,
    email: mailbox.email,
    imapHost: mailbox.host,
    imapPasswordCipher: "cipher",
    inboxUidValidity,
  };
}

export interface SeedRows {
  accounts?: Row[];
  emails?: Row[];
  moved?: Row[];
}

export function newDb(seed: SeedRows = {}): FakeDb {
  return createFakeDb({
    linkedInboxAccount: seed.accounts ?? [accountRow(NAVER), accountRow(ICLOUD)],
    emailMessage: seed.emails ?? [],
    imapMovedMessage: seed.moved ?? [],
  });
}

/** The EmailMessage row a poll stores for a server message. */
export function localRowFor(mailbox: Mailbox, uid: number, message: NewMessage = {}): Row {
  return {
    id: `e-${mailbox.provider}-${uid}`,
    userId: USER,
    gmailId: idOf(mailbox, uid),
    linkedInboxAccountId: mailbox.rowId,
    from: "Kim <kim@example.com>",
    to: mailbox.email,
    subject: message.subject ?? `Subject ${uid}`,
    labels: ["INBOX", "UNREAD"],
    isRead: false,
    receivedAt:
      message.date === undefined ? new Date("2026-08-01T09:00:00Z") : (message.date ?? new Date()),
  };
}

/** Deliver a message to the server's INBOX and to the local table. */
export function deliver(
  db: FakeDb,
  mailbox: Mailbox,
  uid: number,
  message: NewMessage = {},
): string {
  fakeServer.add("INBOX", { ...message, uid });
  db.tables.emailMessage = [...(db.tables.emailMessage ?? []), localRowFor(mailbox, uid, message)];
  return idOf(mailbox, uid);
}

export const localIds = (db: FakeDb): string[] =>
  (db.tables.emailMessage ?? []).map((row) => row.gmailId as string).sort();
