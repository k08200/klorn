/**
 * Step B3: the REAL nodemailer against a local TCP socket (hermetic: no network,
 * no mocks). The other tests fake the transport; this one pins what actually goes
 * over the wire with the options `smtp-transport.ts` builds:
 *
 *   - STARTTLS is mandatory: when the server refuses the upgrade (ETLS), hangs up
 *     during the handshake or answers it with plaintext, the send fails and NOTHING
 *     after EHLO/STARTTLS is sent: no AUTH (so no credential), no MAIL FROM, no
 *     message;
 *   - the exact `raw` bytes and the explicit envelope reach the server, with no
 *     header added or changed by the library;
 *   - the client introduces itself with the fixed EHLO name.
 *
 * The fake server speaks just enough SMTP. A server that really upgrades to TLS
 * would need a certificate the transport (rejectUnauthorized) would rightly
 * refuse, so the plaintext hop for the byte-exactness check disables TLS in the
 * options, and nothing else.
 */

import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { IMAP_PROVIDERS } from "../mail/imap-providers.js";
import { createSmtpTransport, sendRaw, smtpTransportOptions } from "../mail/smtp-transport.js";

interface FakeSmtp {
  port: number;
  commands: string[];
  data: () => Buffer | null;
  close: () => Promise<void>;
}

interface Behaviour {
  advertiseStarttls: boolean;
  /** What the server answers to STARTTLS. */
  starttlsReply: string;
  /**
   * After a 220 to STARTTLS the client sends a TLS ClientHello. "hang-up": close the
   * connection; "plaintext": answer it with a plaintext line, which a TLS layer rejects.
   */
  afterClientHello: "hang-up" | "plaintext";
}

const servers: FakeSmtp[] = [];

async function startFakeSmtp(behaviour: Partial<Behaviour> = {}): Promise<FakeSmtp> {
  const {
    advertiseStarttls = true,
    starttlsReply = "220 Ready to start TLS",
    afterClientHello = "hang-up",
  } = behaviour;
  const commands: string[] = [];
  let captured: Buffer | null = null;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 fake.test ESMTP\r\n");
    let pending = Buffer.alloc(0);
    let inData = false;
    let tlsStarted = false;

    socket.on("data", (chunk) => {
      if (tlsStarted) {
        if (afterClientHello === "hang-up") socket.end();
        else socket.write("554 5.5.1 not a TLS server\r\n");
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (inData) {
          const end = pending.indexOf("\r\n.\r\n");
          if (end === -1) return;
          captured = pending.subarray(0, end + 2); // keep the final CRLF of the message
          pending = pending.subarray(end + 5);
          inData = false;
          socket.write("250 queued\r\n");
          continue;
        }
        const nl = pending.indexOf("\r\n");
        if (nl === -1) return;
        const line = pending.subarray(0, nl).toString("latin1");
        pending = pending.subarray(nl + 2);
        commands.push(line);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") {
          socket.write(
            `250-fake.test\r\n${advertiseStarttls ? "250-STARTTLS\r\n" : ""}250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n`,
          );
        } else if (verb === "STARTTLS") {
          socket.write(`${starttlsReply}\r\n`);
          if (starttlsReply.startsWith("220")) tlsStarted = true;
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else if (verb === "AUTH") {
          socket.write("235 2.7.0 accepted\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeSmtp = {
    port: (server.address() as net.AddressInfo).port,
    commands,
    data: () => captured,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

/** The Naver registry entry, pointed at the local fake; the TLS mode is untouched. */
const localProvider = (port: number) => ({
  ...IMAP_PROVIDERS.NAVER,
  smtp: { host: "127.0.0.1", port, security: "starttls" as const },
});

const CREDS = { email: "me@naver.com", password: "sup3r-secret-app-pw" };
const RAW = Buffer.from(
  [
    "From: me@naver.com",
    "To: bob@example.com",
    "Subject: =?UTF-8?B?SGk=?=",
    "Date: Wed, 30 Sep 2026 10:00:00 +0000",
    "Message-ID: <0b7e3c1a-1111-4222-8333-444455556666@naver.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    "SGVsbG8=",
    "",
  ].join("\r\n"),
);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("STARTTLS is mandatory (real nodemailer)", () => {
  it("fails, before AUTH or any mail command, when the server hangs up during the TLS handshake", async () => {
    const fake = await startFakeSmtp();
    const transport = await createSmtpTransport(localProvider(fake.port), CREDS);
    const error = await sendRaw(transport, {
      from: CREDS.email,
      to: "bob@example.com",
      raw: RAW,
    }).then(
      () => null,
      (err: unknown) => err as { code?: string },
    );
    transport.close();

    // nodemailer 10.0.13 reports a peer closing mid-handshake as ESOCKET, a refused
    // STARTTLS as ETLS (next test); both are TLS-level failures.
    expect(["ETLS", "ESOCKET"]).toContain(error?.code);
    expect(fake.commands.map((c) => c.split(" ")[0])).toEqual(["EHLO", "STARTTLS"]);
    expect(fake.commands.some((c) => /^AUTH/i.test(c))).toBe(false);
    expect(fake.data()).toBeNull();
  });

  it("fails with ETLS, never sending AUTH, when the server refuses STARTTLS", async () => {
    const fake = await startFakeSmtp({
      advertiseStarttls: false,
      starttlsReply: "502 5.5.1 STARTTLS not supported",
    });
    const transport = await createSmtpTransport(localProvider(fake.port), CREDS);
    const error = await sendRaw(transport, {
      from: CREDS.email,
      to: "bob@example.com",
      raw: RAW,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    transport.close();

    expect((error as { code?: string } | null)?.code).toBe("ETLS");
    expect(fake.commands.some((c) => /^AUTH/i.test(c))).toBe(false);
    expect(fake.commands.some((c) => /^MAIL/i.test(c))).toBe(false);
    expect(fake.data()).toBeNull();
  });

  it("fails without AUTH when the server answers the TLS handshake with plaintext", async () => {
    const fake = await startFakeSmtp({ afterClientHello: "plaintext" });
    const transport = await createSmtpTransport(localProvider(fake.port), CREDS);
    const error = await sendRaw(transport, {
      from: CREDS.email,
      to: "bob@example.com",
      raw: RAW,
    }).then(
      () => null,
      (err: unknown) => err as { code?: string },
    );
    transport.close();

    expect(error).not.toBeNull();
    expect(["ETLS", "ESOCKET"]).toContain(error?.code);
    expect(fake.commands.map((c) => c.split(" ")[0])).toEqual(["EHLO", "STARTTLS"]);
    expect(fake.data()).toBeNull();
  });
});

describe("what reaches the server (real nodemailer)", () => {
  /** The real transport options with only TLS switched off, for a plaintext test hop. */
  async function plaintextTransport(port: number) {
    const { createTransport } = await import("nodemailer");
    return createTransport({
      ...smtpTransportOptions(localProvider(port), CREDS),
      requireTLS: false,
      ignoreTLS: true,
      tls: undefined,
    });
  }

  it("puts the exact raw bytes and the explicit envelope on the wire, dot-stuffed and unchanged", async () => {
    const fake = await startFakeSmtp({ advertiseStarttls: false });
    const transport = await plaintextTransport(fake.port);
    const raw = Buffer.concat([RAW, Buffer.from(".leading dot\r\n")]);
    await sendRaw(transport, { from: CREDS.email, to: "bob@example.com", raw });
    transport.close();

    expect(fake.commands).toContain("MAIL FROM:<me@naver.com>");
    expect(fake.commands).toContain("RCPT TO:<bob@example.com>");
    const onWire = fake.data();
    expect(onWire?.toString("latin1")).toContain("\r\n..leading dot\r\n");
    // undo SMTP dot-stuffing: what remains must be byte-identical to what was given
    const unstuffed = Buffer.from(
      (onWire ?? Buffer.alloc(0)).toString("latin1").replace(/\r\n\.\./g, "\r\n."),
      "latin1",
    );
    expect(Buffer.compare(unstuffed, raw)).toBe(0);
  });

  it("adds no header of its own (no Date, X-Mailer or Message-ID beyond the given ones)", async () => {
    const fake = await startFakeSmtp({ advertiseStarttls: false });
    const transport = await plaintextTransport(fake.port);
    await sendRaw(transport, { from: CREDS.email, to: "bob@example.com", raw: RAW });
    transport.close();

    const head = (fake.data() ?? Buffer.alloc(0)).toString("latin1").split("\r\n\r\n")[0];
    expect(head.split("\r\n")).toEqual(RAW.toString("latin1").split("\r\n\r\n")[0].split("\r\n"));
  });

  it("introduces itself with EHLO klorn.ai, not the machine's hostname", async () => {
    const fake = await startFakeSmtp({ advertiseStarttls: false });
    const transport = await plaintextTransport(fake.port);
    await sendRaw(transport, { from: CREDS.email, to: "bob@example.com", raw: RAW });
    transport.close();

    expect(fake.commands[0]).toBe("EHLO klorn.ai");
  });
});
