/**
 * Shared fakes for the B3 provider tests (imap-send-*.test.ts): a scripted
 * nodemailer transport, an imapflow client, and the account rows, folders and
 * helpers those tests use. Kept free of imports from `src/mail` on purpose: the
 * tests' `vi.mock` factories load this module, and a mocked module (`db.js`)
 * that imported the code under test back would be a cycle.
 *
 * Each test file wires the mocks itself (vi.mock is per file):
 *   vi.mock("imapflow", async () => ({ ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow }));
 */

import type net from "node:net";

import { vi } from "vitest";

export const h = {
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  transportClose: vi.fn(),
  imapCtorOpts: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  list: vi.fn(),
  getMailboxLock: vi.fn(),
  search: vi.fn(),
  append: vi.fn(),
  fetchOne: vi.fn(),
  fetch: vi.fn(),
  messageFlagsAdd: vi.fn(),
  messageFlagsRemove: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  release: vi.fn(),
  findFirst: vi.fn(),
  decryptToken: vi.fn(),
  captureError: vi.fn(),
  /** Times the nodemailer mock factory ran, i.e. times the package was first imported. */
  nodemailerLoads: 0,
};

export class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    h.imapCtorOpts.push(opts);
  }
  /** What `client.mailbox` reports once INBOX is selected (B1 flag actions compare its UIDVALIDITY). */
  mailbox = { path: "INBOX", uidValidity: 7n };
  connect = h.connect;
  list = h.list;
  getMailboxLock = h.getMailboxLock;
  search = h.search;
  append = h.append;
  fetchOne = h.fetchOne;
  fetch = h.fetch;
  messageFlagsAdd = h.messageFlagsAdd;
  messageFlagsRemove = h.messageFlagsRemove;
  logout = h.logout;
  close = h.close;
  on = h.on;
}

export const PASSWORD = "sup3r-secret-app-pw";
export const CIPHER = "v2:k:iv:ct:tag";
/** The INBOX UIDVALIDITY these rows were baselined with (step B2); FakeImapFlow reports the same. */
export const INBOX_UID_VALIDITY = "7";
export const NAVER_ROW = {
  id: "row-1",
  email: "me@naver.com",
  imapHost: "imap.naver.com:993",
  imapPasswordCipher: CIPHER,
  inboxUidValidity: INBOX_UID_VALIDITY,
};
export const ICLOUD_ROW = {
  id: "row-2",
  email: "me@icloud.com",
  imapHost: "imap.mail.me.com:993",
  imapPasswordCipher: CIPHER,
  inboxUidValidity: INBOX_UID_VALIDITY,
};
export const NAVER_MSG = "naver-imap:me@naver.com:101";
export const ORIGINAL_ID = "<orig-1@mail.example.com>";
export const draftInput = { to: "bob@example.com", subject: "Re: Hi", body: "Draft body" };

/**
 * A folder as imapflow's `list()` returns it. Only the winning folder of each
 * role carries `specialUse`; `specialUseSource` is "extension" when the server
 * sent a SPECIAL-USE flag and "name" when the role came from the folder's name
 * (imapflow reports its looser name-guess tier as "name" too).
 */
export function folder(
  path: string,
  role?: { specialUse: string; specialUseSource: "user" | "extension" | "name" },
  flags: string[] = [],
  delimiter = "/",
) {
  const parts = path.split(delimiter);
  const name = parts.pop() ?? path;
  return {
    path,
    pathAsListed: path,
    name,
    delimiter,
    parent: parts,
    parentPath: parts.join(delimiter),
    flags: new Set(flags),
    listed: true,
    subscribed: true,
    ...(role ?? {}),
  };
}

/** An iCloud-shaped listing: server-flagged Sent, name-matched Drafts. */
export const FOLDERS = [
  folder("INBOX", { specialUse: "\\Inbox", specialUseSource: "extension" }),
  folder("Sent Messages", { specialUse: "\\Sent", specialUseSource: "extension" }),
  folder("Drafts", { specialUse: "\\Drafts", specialUseSource: "name" }),
  folder("Deleted Messages", { specialUse: "\\Trash", specialUseSource: "extension" }),
];

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Let queued promise work finish, under real or fake timers. */
export async function settle(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await flush();
}

export const authRejected = () =>
  Object.assign(new Error("Invalid login: 535 5.7.8 authentication failed"), {
    code: "EAUTH",
    responseCode: 535,
  });
export const imapAuthRejected = () =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    serverResponseCode: "AUTHENTICATIONFAILED",
  });

/** Script every fake for a healthy mailbox whose row is `row` (null: no such row). */
export function arm(row: Record<string, unknown> | null = NAVER_ROW) {
  h.findFirst.mockImplementation(async () => row);
  h.decryptToken.mockReturnValue(PASSWORD);
  h.createTransport.mockImplementation(() => ({
    sendMail: h.sendMail,
    close: h.transportClose,
  }));
  h.sendMail.mockResolvedValue({ accepted: ["bob@example.com"], rejected: [] });
  h.connect.mockResolvedValue(undefined);
  h.list.mockResolvedValue(FOLDERS);
  h.getMailboxLock.mockResolvedValue({ release: h.release });
  h.search.mockResolvedValue([]);
  h.append.mockResolvedValue({ destination: "Sent Messages", uid: 7 });
  h.fetchOne.mockResolvedValue({
    uid: 101,
    headers: Buffer.from(
      `Message-ID: ${ORIGINAL_ID}\r\nReferences: <root@x.example>\r\n <mid@x.example>\r\n\r\n`,
    ),
  });
  h.logout.mockResolvedValue(undefined);
}

/** Reset every mock and the recorded constructor options, then arm a healthy NAVER mailbox. */
export function resetHarness() {
  for (const fn of Object.values(h)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  h.imapCtorOpts.length = 0;
}

export function loggedText(): string {
  // Only the console methods a test has spied on (vi.spyOn) have a `.mock`.
  const spies = ([console.warn, console.error, console.log] as unknown[]).filter(
    (spy): spy is { mock: { calls: unknown[][] } } => typeof spy === "function" && "mock" in spy,
  );
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map(String).join(" "))
    .join("\n");
}

export const sentRaw = () => h.sendMail.mock.calls[0][0].raw as Buffer;
export const sentMime = () => sentRaw().toString("utf-8");
export const header = (mime: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "mi").exec(mime.split("\r\n\r\n")[0])?.[1];

/** The socket the newest SMTP session handed to nodemailer (an unconnected net.Socket). */
export const lastSmtpSocket = (): net.Socket =>
  h.createTransport.mock.calls[h.createTransport.mock.calls.length - 1][0].socket;

/** The next SMTP send fails as if the TCP connection had NOT been established. */
export function failBeforeConnect(err: Error) {
  h.sendMail.mockImplementationOnce(async () => {
    throw err;
  });
}

/** The next SMTP send fails on a connection that WAS established (and then went wrong). */
export function failAfterConnect(err: Error) {
  h.sendMail.mockImplementationOnce(async () => {
    lastSmtpSocket().emit("connect");
    throw err;
  });
}
