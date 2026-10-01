/**
 * A wall-clock limit on one IMAP session, for every provider (step B4 review fix).
 *
 * imapflow's own timers are inactivity timers: any byte resets them, so a server that
 * answers slowly but never stops can hold a session (and the serial poll behind it)
 * for good. This closes the connection when the session has lasted too long,
 * whatever it is doing. The deadline starts at `connect()`, so a client that is built
 * and never used costs no timer, and it ends with the session: a normal close, the
 * connection closing by itself, or a failed connect all cancel it.
 *
 * Fixed-host providers (Naver, iCloud) get the generous FIXED_HOST_SESSION_DEADLINE_MS
 * of imap-connection.ts and are otherwise unchanged. The generic client has its own,
 * tighter deadline woven into its pinned connect (imap-pinned-client.ts), built on the
 * same `armTimer`.
 */

import type { ImapFlow } from "imapflow";

/** A timer that does not keep the process alive; returns the function that cancels it. */
export function armTimer(ms: number, onExpire: () => void): () => void {
  const timer = setTimeout(onExpire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Decorate `client` so a session longer than `ms` is hard-closed. Returns the same client. */
export function limitSessionTime(client: ImapFlow, ms: number): ImapFlow {
  // A client that cannot connect has no session to limit.
  if (typeof client.connect !== "function" || typeof client.close !== "function") return client;
  const connect = client.connect.bind(client);
  const close = client.close.bind(client);
  let cancel: () => void = () => {};

  client.close = () => {
    cancel();
    close();
  };
  // The connection ended by itself (error, server BYE): nothing is left to cut off.
  client.on("close", () => cancel());
  client.connect = async () => {
    cancel = armTimer(ms, close);
    try {
      await connect();
    } catch (err) {
      cancel();
      throw err;
    }
  };
  return client;
}
