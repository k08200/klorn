/**
 * A small STATEFUL IMAP server behind a fake imapflow, for the B2 move tests.
 * There is no public Naver or iCloud sandbox, so this is the only place the
 * conversation "MOVE assigns a new UID, UIDVALIDITY renumbers" is exercised. It
 * models what those tests depend on, faithfully enough that a wrong call fails:
 *
 *   - folders, each with its own UIDVALIDITY, next UID and messages (flags,
 *     Message-ID, subject, date, body), and LIST entries with SPECIAL-USE flags;
 *   - SELECT through `getMailboxLock`; a SECOND lock while one is held throws,
 *     because imapflow would wait for the first forever (a deadlock in production);
 *   - `fetch` by UID or by sequence number, `search` by Message-ID, `status`;
 *   - `messageMove` exactly as imapflow 1.7.0 does it: a real UID MOVE when the
 *     server advertises MOVE, and otherwise COPY + `\Deleted` + EXPUNGE. The
 *     fallback is modelled on purpose: the code under test must never reach it,
 *     and `commands` shows whether it did;
 *   - COPYUID in the MOVE answer (switchable), and a programmable NO.
 *
 * Kept free of imports from `src/mail`: the tests' `vi.mock("imapflow")` factory
 * loads this module.
 */

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  messageId: string | null;
  subject: string;
  date: Date | null;
  from: string;
  body: string;
}

export interface FakeFolder {
  path: string;
  uidValidity: bigint;
  nextUid: number;
  messages: Map<number, FakeMessage>;
  specialUse?: string;
  specialUseSource?: "extension" | "name" | "user";
  flags: Set<string>;
}

export type NewMessage = Partial<Omit<FakeMessage, "uid">> & { uid?: number };

const DEFAULT_DATE = new Date("2026-08-01T09:00:00Z");

class NoResponseError extends Error {
  responseStatus = "NO";
  constructor(message: string) {
    super(message);
    this.name = "ImapFlowError";
  }
}

function expandRange(range: string, max: number): number[] {
  return range.split(",").flatMap((part) => {
    if (!part.includes(":")) return [Number(part)];
    const [from, to] = part.split(":");
    const last = to === "*" ? max : Number(to);
    return Array.from({ length: Math.max(0, last - Number(from) + 1) }, (_, i) => Number(from) + i);
  });
}

export class FakeImapServer {
  folders = new Map<string, FakeFolder>();
  capabilities = new Map<string, boolean | number>();
  /** The MOVE answer carries a COPYUID response code (UIDPLUS). */
  copyUid = true;
  /** A MOVE whose UID set contains one of these is answered NO. */
  refuseMoveFor = new Set<number>();
  /** SEARCH answers with no hits whatever the folder holds (a server that cannot confirm a read-back). */
  searchFindsNothing = false;
  /**
   * Runs once inside the next sequence-number FETCH (a poll's window), AFTER the
   * messages were read and BEFORE the first one is handed back: the moment an
   * action can land while a poll already holds a stale snapshot.
   */
  midFetchHook: (() => Promise<void>) | null = null;
  /** Every command the fake served, in order ("UID MOVE 101 Trash", "EXPUNGE", ...). */
  commands: string[] = [];
  logins = 0;
  logouts = 0;
  closes = 0;
  /** Locks currently held, over all clients; 0 when every path released its lock. */
  openLocks = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.folders = new Map();
    this.capabilities = new Map<string, boolean | number>([
      ["IMAP4REV1", true],
      ["UIDPLUS", true],
      ["MOVE", true],
    ]);
    this.copyUid = true;
    this.refuseMoveFor = new Set();
    this.searchFindsNothing = false;
    this.midFetchHook = null;
    this.commands = [];
    this.logins = 0;
    this.logouts = 0;
    this.closes = 0;
    this.openLocks = 0;
    this.addFolder("INBOX", 1000n);
    this.addFolder("Trash", 2000n, { specialUse: "\\Trash", specialUseSource: "extension" });
    this.addFolder("Archive", 3000n, { specialUse: "\\Archive", specialUseSource: "extension" });
  }

  addFolder(
    path: string,
    uidValidity: bigint,
    extra: Partial<Pick<FakeFolder, "specialUse" | "specialUseSource" | "flags">> = {},
  ): FakeFolder {
    const folder: FakeFolder = {
      path,
      uidValidity,
      nextUid: 1,
      messages: new Map(),
      flags: new Set(),
      ...extra,
    };
    this.folders.set(path, folder);
    return folder;
  }

  folder(path: string): FakeFolder {
    const found = this.folders.get(path);
    if (!found) throw new NoResponseError(`no such mailbox ${path}`);
    return found;
  }

  /** Deliver a message into `path`; returns its UID. */
  add(path: string, partial: NewMessage = {}): number {
    const folder = this.folder(path);
    const uid = partial.uid ?? folder.nextUid;
    folder.nextUid = Math.max(folder.nextUid, uid + 1);
    folder.messages.set(uid, {
      uid,
      flags: partial.flags ?? new Set(),
      messageId: partial.messageId === undefined ? `<m${uid}@example.com>` : partial.messageId,
      subject: partial.subject ?? `Subject ${uid}`,
      date: partial.date === undefined ? DEFAULT_DATE : partial.date,
      from: partial.from ?? "kim@example.com",
      body: partial.body ?? `Body ${uid}`,
    });
    return uid;
  }

  uidsIn(path: string): number[] {
    return [...this.folder(path).messages.keys()].sort((a, b) => a - b);
  }

  /** The server renumbers the mailbox: a new UIDVALIDITY and UIDs restart at 1. */
  renumber(path: string, uidValidity: bigint): void {
    const folder = this.folder(path);
    const ordered = this.uidsIn(path).map((uid) => folder.messages.get(uid) as FakeMessage);
    folder.uidValidity = uidValidity;
    folder.messages = new Map(ordered.map((m, i) => [i + 1, { ...m, uid: i + 1 }]));
    folder.nextUid = ordered.length + 1;
  }

  /** Commands that would make an action a permanent delete. */
  get destructiveCommands(): string[] {
    return this.commands.filter((c) => /EXPUNGE|\\Deleted|COPY /.test(c));
  }
}

export const fakeServer = new FakeImapServer();

type Envelope = {
  from: Array<{ name: string; address: string }>;
  to: Array<{ name: string; address: string }>;
  cc: null;
  subject: string;
  date: Date | undefined;
  messageId: string | undefined;
};

interface FetchQuery {
  envelope?: boolean;
  flags?: boolean;
  bodyParts?: string[];
}

function envelopeOf(m: FakeMessage): Envelope {
  return {
    from: [{ name: "Kim", address: m.from }],
    to: [{ name: "", address: "me@example.com" }],
    cc: null,
    subject: m.subject,
    date: m.date ?? undefined,
    messageId: m.messageId ?? undefined,
  };
}

export class FakeImapFlow {
  capabilities = fakeServer.capabilities;
  mailbox: false | { path: string; uidValidity: bigint } = false;
  private held: string | null = null;

  constructor(readonly options: Record<string, unknown> = {}) {}

  on = () => this;

  connect = async () => {
    fakeServer.logins += 1;
    fakeServer.commands.push("LOGIN");
  };

  logout = async () => {
    fakeServer.logouts += 1;
    fakeServer.commands.push("LOGOUT");
  };

  close = () => {
    fakeServer.closes += 1;
  };

  getMailboxLock = async (path: string) => {
    if (this.held !== null) {
      throw new Error(
        `fake imapflow: a second mailbox lock (${path}) while ${this.held} is held would deadlock`,
      );
    }
    const folder = fakeServer.folder(path);
    if (this.mailbox === false || this.mailbox.path !== path) {
      fakeServer.commands.push(`SELECT ${path}`);
    }
    this.mailbox = { path, uidValidity: folder.uidValidity };
    this.held = path;
    fakeServer.openLocks += 1;
    return {
      release: () => {
        if (this.held === null) return;
        this.held = null;
        fakeServer.openLocks -= 1;
      },
    };
  };

  status = async (path: string, query: { messages?: boolean; uidValidity?: boolean }) => {
    const folder = fakeServer.folder(path);
    fakeServer.commands.push(`STATUS ${path}`);
    return {
      path,
      ...(query.messages ? { messages: folder.messages.size } : {}),
      ...(query.uidValidity ? { uidValidity: folder.uidValidity } : {}),
    };
  };

  list = async () => {
    fakeServer.commands.push("LIST");
    return [...fakeServer.folders.values()].map((f) => ({
      path: f.path,
      pathAsListed: f.path,
      name: f.path.split("/").pop() ?? f.path,
      delimiter: "/",
      flags: new Set(f.flags),
      listed: true,
      ...(f.specialUse ? { specialUse: f.specialUse, specialUseSource: f.specialUseSource } : {}),
    }));
  };

  private selected(): FakeFolder {
    if (this.mailbox === false) throw new Error("fake imapflow: no mailbox selected");
    return fakeServer.folder(this.mailbox.path);
  }

  fetch(range: string, query: FetchQuery, opts?: { uid?: boolean }) {
    const folder = this.selected();
    const ordered = fakeServer.uidsIn(folder.path);
    const wanted = opts?.uid
      ? expandRange(range, Math.max(0, ...ordered)).filter((uid) => folder.messages.has(uid))
      : expandRange(range, ordered.length)
          .map((seq) => ordered[seq - 1])
          .filter((uid): uid is number => uid !== undefined);
    fakeServer.commands.push(`${opts?.uid ? "UID " : ""}FETCH ${range}`);
    // The server reads the messages when the command arrives; a later change does not reach this answer.
    const snapshot = wanted.map((uid) => {
      const m = folder.messages.get(uid) as FakeMessage;
      return { ...m, flags: new Set(m.flags) };
    });
    const hook = opts?.uid ? null : fakeServer.midFetchHook;
    if (hook) fakeServer.midFetchHook = null;
    return (async function* () {
      if (hook) await hook();
      for (const m of snapshot) {
        yield {
          uid: m.uid,
          ...(query.flags ? { flags: m.flags } : {}),
          ...(query.envelope ? { envelope: envelopeOf(m) } : {}),
          ...(query.bodyParts ? { bodyParts: new Map([["text", Buffer.from(m.body)]]) } : {}),
        };
      }
    })();
  }

  search = async (query: { header?: Record<string, string> }, opts?: { uid?: boolean }) => {
    const folder = this.selected();
    const wanted = query.header?.["message-id"];
    fakeServer.commands.push(`${opts?.uid ? "UID " : ""}SEARCH HEADER Message-ID`);
    if (fakeServer.searchFindsNothing) return [];
    return fakeServer
      .uidsIn(folder.path)
      .filter((uid) => (folder.messages.get(uid) as FakeMessage).messageId === wanted);
  };

  private store(range: string, flags: string[], add: boolean): boolean {
    const folder = this.selected();
    fakeServer.commands.push(`UID STORE ${add ? "+" : "-"}FLAGS ${range}`);
    for (const uid of expandRange(range, Math.max(0, ...fakeServer.uidsIn(folder.path)))) {
      const held = folder.messages.get(uid)?.flags;
      if (!held) continue;
      for (const flag of flags) {
        if (add) held.add(flag);
        else held.delete(flag);
      }
    }
    return true;
  }

  messageFlagsAdd = async (range: string, flags: string[]) => this.store(range, flags, true);
  messageFlagsRemove = async (range: string, flags: string[]) => this.store(range, flags, false);

  /** The EXPUNGE half of imapflow's MOVE emulation. Must never be called by the code under test. */
  messageDelete = async (range: string) => {
    const folder = this.selected();
    fakeServer.commands.push(`STORE +FLAGS \\Deleted ${range}`);
    fakeServer.commands.push(`EXPUNGE ${range}`);
    for (const uid of expandRange(range, Math.max(0, ...fakeServer.uidsIn(folder.path)))) {
      folder.messages.delete(uid);
    }
    return true;
  };

  messageMove = async (range: string, destination: string, opts?: { uid?: boolean }) => {
    const source = this.selected();
    const target = fakeServer.folders.get(destination);
    if (!fakeServer.capabilities.has("MOVE")) {
      // imapflow 1.7.0 lib/commands/move.js: COPY, then delete (flag + EXPUNGE).
      fakeServer.commands.push(`COPY ${range} ${destination}`);
      const map = this.transfer(source, target, range, false);
      await this.messageDelete(range);
      return { path: source.path, destination, ...(map ? map : {}) };
    }
    fakeServer.commands.push(`${opts?.uid ? "UID " : ""}MOVE ${range} ${destination}`);
    const uids = expandRange(range, Math.max(0, ...fakeServer.uidsIn(source.path)));
    if (!target || uids.some((uid) => fakeServer.refuseMoveFor.has(uid))) return false;
    const map = this.transfer(source, target, range, true);
    return { path: source.path, destination, ...(map ? map : {}) };
  };

  /** Copy (and for a MOVE, remove) the existing UIDs of `range`; the COPYUID map if it is sent. */
  private transfer(
    source: FakeFolder,
    target: FakeFolder | undefined,
    range: string,
    removeFromSource: boolean,
  ): { uidValidity: bigint; uidMap: Map<number, number> } | null {
    if (!target) return null;
    const existing = expandRange(range, Math.max(0, ...fakeServer.uidsIn(source.path))).filter(
      (uid) => source.messages.has(uid),
    );
    const uidMap = new Map<number, number>();
    for (const uid of existing) {
      const m = source.messages.get(uid) as FakeMessage;
      const next = target.nextUid;
      target.nextUid += 1;
      target.messages.set(next, { ...m, uid: next, flags: new Set(m.flags) });
      uidMap.set(uid, next);
      if (removeFromSource) source.messages.delete(uid);
    }
    return fakeServer.copyUid ? { uidValidity: target.uidValidity, uidMap } : null;
  }
}
