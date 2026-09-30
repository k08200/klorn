/**
 * What a failed send SAYS about delivery.
 *
 * SMTP cannot tell a connection that died before the message was handed over from
 * one that died after. nodemailer reports both, and a stall after DATA, as
 * `ETIMEDOUT command=CONN` or `ECONNECTION command=CONN`, so the error's `command`
 * proves nothing. What the sender does know is whether the TCP connection was ever
 * established (it owns the socket). Only a failure that provably came before any
 * MAIL FROM may say "not sent": a connect that never completed, DNS, TLS/STARTTLS,
 * AUTH. Any other transport error on an established connection says delivery is
 * NOT CONFIRMED and sends the user to their Sent folder, never "Try again
 * shortly", which invites a duplicate. A server's own refusal is a definite answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arm,
  authRejected,
  failAfterConnect,
  failBeforeConnect,
  h,
  loggedText,
  PASSWORD,
  resetHarness,
  settle,
} from "./helpers/imap-send-harness.js";

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow,
}));
vi.mock("nodemailer", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { createTransport: (...args: unknown[]) => h.createTransport(...args) };
});
vi.mock("../db.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  const prisma = {
    linkedInboxAccount: { findFirst: (...args: unknown[]) => h.findFirst(...args) },
    emailMessage: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { decryptToken: (...args: unknown[]) => h.decryptToken(...args) };
});
vi.mock("../sentry.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { captureError: (...args: unknown[]) => h.captureError(...args) };
});

const { imapSendActions } = await import("../mail/providers/imap-send.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

const naver = imapSendActions("NAVER");
const send = () =>
  naver.sendEmail("u1", "bob@example.com", "Hi", "b", [], { linkedInboxAccountId: "row-1" });

const NOT_SENT = "Could not reach Naver. The message was not sent; try again shortly.";
const UNCONFIRMED =
  "Naver did not confirm delivery. The message may or may not have been sent; check your Sent folder before trying again.";

const err = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`${code} ${PASSWORD} bob@example.com`), { code, ...extra });

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
});
afterEach(() => vi.restoreAllMocks());

describe("provably before any MAIL FROM: 'not sent'", () => {
  it.each([
    ["a connection that never completed (refused)", err("ECONNECTION", { command: "CONN" })],
    ["a connect timeout", err("ETIMEDOUT", { command: "CONN" })],
    ["a socket error before the connection", err("ESOCKET", { command: "CONN" })],
  ])("%s", async (_name, error) => {
    failBeforeConnect(error);
    expect(await send()).toEqual({ error: NOT_SENT });
  });

  it.each([
    ["DNS failure", err("EDNS", { command: "CONN" })],
    ["a TLS handshake failure", err("ETLS", { command: "CONN" })],
    ["a refused STARTTLS", err("ETLS", { responseCode: 502, command: "STARTTLS" })],
    ["a login that failed without a rejection code", err("EAUTH", { responseCode: 454 })],
  ])("%s, even on an established connection", async (_name, error) => {
    failAfterConnect(error);
    expect(await send()).toEqual({ error: NOT_SENT });
  });

  it("a rejected login keeps its reconnect wording and starts the shared cooldown", async () => {
    failAfterConnect(authRejected());
    expect(await send()).toEqual({
      error: "Naver rejected the saved app password. Reconnect your Naver mailbox in Settings.",
    });
    h.createTransport.mockClear();
    expect(await send()).toHaveProperty("error");
    expect(h.createTransport).not.toHaveBeenCalled();
  });
});

describe("after the connection was established: 'delivery not confirmed'", () => {
  it.each([
    ["a stall after DATA (ETIMEDOUT reported on CONN)", err("ETIMEDOUT", { command: "CONN" })],
    ["a connection dropped mid-message", err("ECONNECTION", { command: "CONN" })],
    ["a socket error on an open connection", err("ESOCKET", { command: "CONN" })],
    ["an invalid server response", err("EPROTOCOL", { command: "DATA" })],
    ["a stream failure", err("ESTREAM", { command: "API" })],
    ["an error with no code", new Error("who knows")],
  ])("%s", async (_name, error) => {
    failAfterConnect(error);
    const result = await send();
    expect(result).toEqual({ error: UNCONFIRMED });
    expect(JSON.stringify(result)).not.toMatch(/Could not reach|Try again shortly/);
  });

  it("names the Sent folder and never invites an immediate retry", async () => {
    failAfterConnect(err("ETIMEDOUT", { command: "CONN" }));
    const { error } = (await send()) as { error: string };
    expect(error).toContain("Sent folder");
    expect(error).toContain("before trying again");
    expect(error).not.toMatch(/try again shortly/i);
  });

  it("does not start a cooldown (the mailbox itself is fine)", async () => {
    failAfterConnect(err("ETIMEDOUT", { command: "CONN" }));
    await send();
    expect(await send()).toHaveProperty("success", true);
  });

  it("is still logged and reported (throttled) without the server's text", async () => {
    failAfterConnect(err("ETIMEDOUT", { command: "CONN" }));
    await send();
    expect(loggedText()).toContain("code=ETIMEDOUT");
    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain("bob@example.com");
    expect(h.captureError).toHaveBeenCalledTimes(1);
  });

  it("does not try to file a Sent copy of a message that may not have gone out", async () => {
    failAfterConnect(err("ETIMEDOUT", { command: "CONN" }));
    await send();
    await settle();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(h.append).not.toHaveBeenCalled();
  });
});

describe("a server's own answer is definite", () => {
  it("a refused recipient, sender and message keep their specific wording", async () => {
    failAfterConnect(err("EENVELOPE", { responseCode: 550, command: "RCPT TO" }));
    expect(await send()).toEqual({ error: "Naver rejected the recipient address." });
    failAfterConnect(err("EENVELOPE", { responseCode: 553, command: "MAIL FROM" }));
    expect(await send()).toEqual({ error: "Naver did not accept the sending address." });
    failAfterConnect(err("EMESSAGE", { responseCode: 554 }));
    expect(await send()).toEqual({ error: "Naver refused the message." });
  });
});
