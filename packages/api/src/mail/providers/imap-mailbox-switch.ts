/**
 * One mailbox selected at a time inside an action session (step B2).
 *
 * The flag actions of B1 keep INBOX locked for a whole session. A move back out of
 * Trash or Archive needs another mailbox selected, and imapflow's
 * `getMailboxLock` WAITS while another lock is held, so asking for a second one
 * without releasing the first never returns. Everything in a session therefore
 * goes through this switch: it holds at most one lock, releases it before taking
 * another, and hands back the live UIDVALIDITY of whatever it selected. A session
 * that only touches INBOX takes exactly one lock, as before.
 */

import type { ImapFlow } from "imapflow";
import { liveUidValidity } from "../imap-uidvalidity.js";

export interface MailboxSwitch {
  /**
   * Select `path`, releasing the previous mailbox first unless it is the same one.
   * Resolves with the mailbox's live UIDVALIDITY, or null when the server did not
   * report a usable one. Rejects as imapflow does (for example when the folder does
   * not exist); the switch then holds no lock.
   */
  open(path: string): Promise<string | null>;
  /** Release whatever is held. Safe to call more than once. */
  release(): void;
}

interface Held {
  path: string;
  release: () => void;
}

export function createMailboxSwitch(client: ImapFlow): MailboxSwitch {
  let held: Held | null = null;

  const release = (): void => {
    const current = held;
    held = null;
    current?.release();
  };

  return {
    open: async (path) => {
      if (held?.path !== path) {
        release();
        const lock = await client.getMailboxLock(path);
        held = { path, release: () => lock.release() };
      }
      return liveUidValidity(client.mailbox);
    },
    release,
  };
}
