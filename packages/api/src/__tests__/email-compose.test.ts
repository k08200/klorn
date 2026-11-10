import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

// Spy on the Gmail send boundary so no real network/OAuth is touched.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));

vi.mock("../mail/gmail.js", () => ({
  sendEmail: sendEmailMock,
  archiveEmail: vi.fn(),
  toggleReadGmail: vi.fn(),
  toggleStarGmail: vi.fn(),
  trashEmail: vi.fn(),
  unarchiveEmail: vi.fn(),
  untrashEmail: vi.fn(),
}));

// email-mutations imports syncEmailByGmailId transitively; stub it so the
// import graph stays light and side-effect free.
vi.mock("../mail/email-sync.js", () => ({ syncEmailByGmailId: vi.fn() }));

// requireAuth touches user + device rows. A valid session has a registered
// device (every login calls registerDevice), so the device lookup must resolve
// for auth to pass; null sessionsInvalidatedAt means not revoked.
vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: "user-1", sessionsInvalidatedAt: null })) },
    device: {
      findUnique: vi.fn(async () => ({ id: "auth-device", userId: "user-1" })),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    },
    emailMessage: { findFirst: vi.fn(async () => null) },
  };
  return { prisma, db: prisma };
});

const TOKEN = signToken({ userId: "user-1", email: "t@e.com" });
const auth = () => ({ authorization: `Bearer ${TOKEN}` });

type Part =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; content: Buffer };

const BOUNDARY = "----klorncomposetest";

/** Build a multipart/form-data body without pulling in a form-data dep. */
function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if ("value" in part) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(part.value));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        ),
      );
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`));
      chunks.push(part.content);
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

async function buildApp() {
  const { registerEmailMutationsRoutes } = await import("../routes/email-mutations.js");
  const app = Fastify();
  await app.register(async (instance) => {
    await registerEmailMutationsRoutes(instance);
  });
  return app;
}

describe("POST /api/email/compose", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ success: true, messageId: "msg-1" });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "alice@example.com" },
      { name: "subject", value: "Hi" },
      { name: "body", value: "Hello" },
    ]);
    const res = await app.inject({ method: "POST", url: "/compose", headers, payload });
    expect(res.statusCode).toBe(401);
    expect(sendEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("sends a plain message with no attachments", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "alice@example.com" },
      { name: "subject", value: "Quarterly report" },
      { name: "body", value: "See the numbers below." },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, messageId: "msg-1" });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [uid, to, subject, body, attachments] = sendEmailMock.mock.calls[0];
    expect(uid).toBe("user-1");
    expect(to).toBe("alice@example.com");
    expect(subject).toBe("Quarterly report");
    expect(body).toBe("See the numbers below.");
    expect(attachments).toEqual([]);
    await app.close();
  });

  it("forwards an uploaded file as an attachment buffer", async () => {
    const app = await buildApp();
    const fileBytes = Buffer.from("PDF-CONTENT-BYTES", "utf-8");
    const { payload, headers } = multipart([
      { name: "to", value: "bob@example.com" },
      { name: "subject", value: "Invoice" },
      { name: "body", value: "Attached." },
      {
        name: "files",
        filename: "invoice.pdf",
        contentType: "application/pdf",
        content: fileBytes,
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const attachments = sendEmailMock.mock.calls[0][4];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("invoice.pdf");
    expect(attachments[0].mimeType).toBe("application/pdf");
    expect(Buffer.isBuffer(attachments[0].content)).toBe(true);
    expect(attachments[0].content.toString("utf-8")).toBe("PDF-CONTENT-BYTES");
    await app.close();
  });

  it("rejects an attachment whose declared type is not allowlisted with 415", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "bob@example.com" },
      { name: "subject", value: "Tool" },
      { name: "body", value: "Run this." },
      {
        name: "files",
        filename: "setup.exe",
        contentType: "application/x-msdownload",
        content: Buffer.from("MZ..."),
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatch(/not allowed/i);
    expect(sendEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes MIME parameters and case before the allowlist check", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "bob@example.com" },
      { name: "subject", value: "Notes" },
      { name: "body", value: "Attached." },
      {
        name: "files",
        filename: "notes.txt",
        contentType: "TEXT/Plain; charset=utf-8",
        content: Buffer.from("hello"),
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts forwarded email (.eml) and modern iWork types", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "bob@example.com" },
      { name: "subject", value: "Docs" },
      { name: "body", value: "Attached." },
      {
        name: "files",
        filename: "original.eml",
        contentType: "message/rfc822",
        content: Buffer.from("From: a@b.c"),
      },
      {
        name: "files",
        filename: "deck.pages",
        contentType: "application/vnd.apple.pages",
        content: Buffer.from("PK"),
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects macro-enabled Office formats (the vnd.ms- prefix is deliberately not blanket-allowed)", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "bob@example.com" },
      { name: "subject", value: "Sheet" },
      { name: "body", value: "Attached." },
      {
        name: "files",
        filename: "macro.xlsm",
        contentType: "application/vnd.ms-excel.sheet.macroenabled.12",
        content: Buffer.from("PK"),
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it("still accepts the octet-stream fallback (clients that don't sniff types)", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "bob@example.com" },
      { name: "subject", value: "Data" },
      { name: "body", value: "Attached." },
      {
        name: "files",
        filename: "data.bin",
        contentType: "application/octet-stream",
        content: Buffer.from([0, 1, 2]),
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 400 when a required field is missing", async () => {
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "alice@example.com" },
      { name: "body", value: "No subject here" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(sendEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("surfaces a sendEmail rejection (e.g. invalid address) as 400", async () => {
    sendEmailMock.mockResolvedValue({ error: "Invalid email address" });
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "not-an-email" },
      { name: "subject", value: "Hi" },
      { name: "body", value: "Hello" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Invalid email address" });
    await app.close();
  });

  it("rejects more than the allowed number of attachments with 413", async () => {
    const app = await buildApp();
    const fileParts: Part[] = Array.from({ length: 11 }, (_, i) => ({
      name: "files",
      filename: `f${i}.txt`,
      contentType: "text/plain",
      content: Buffer.from(`file-${i}`),
    }));
    const { payload, headers } = multipart([
      { name: "to", value: "alice@example.com" },
      { name: "subject", value: "Too many" },
      { name: "body", value: "Body" },
      ...fileParts,
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(sendEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a single attachment over the per-file size limit with 413", async () => {
    const app = await buildApp();
    // 26 MB > the 25 MB per-file cap → @fastify/multipart throws on toBuffer().
    const big = Buffer.alloc(26 * 1024 * 1024, 0x61);
    const { payload, headers } = multipart([
      { name: "to", value: "alice@example.com" },
      { name: "subject", value: "Big file" },
      { name: "body", value: "Body" },
      { name: "files", filename: "big.bin", contentType: "application/octet-stream", content: big },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(sendEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects attachments whose combined size exceeds the cap with 413", async () => {
    const app = await buildApp();
    // Two 13 MB files each pass the per-file cap but sum to 26 MB > 25 MB total.
    const chunk = () => Buffer.alloc(13 * 1024 * 1024, 0x62);
    const { payload, headers } = multipart([
      { name: "to", value: "alice@example.com" },
      { name: "subject", value: "Combined too big" },
      { name: "body", value: "Body" },
      {
        name: "files",
        filename: "a.bin",
        contentType: "application/octet-stream",
        content: chunk(),
      },
      {
        name: "files",
        filename: "b.bin",
        contentType: "application/octet-stream",
        content: chunk(),
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(sendEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 502 when sendEmail throws (transient Gmail failure)", async () => {
    sendEmailMock.mockRejectedValue(new Error("Gmail 503"));
    const app = await buildApp();
    const { payload, headers } = multipart([
      { name: "to", value: "alice@example.com" },
      { name: "subject", value: "Boom" },
      { name: "body", value: "Body" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/compose",
      headers: { ...auth(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("Gmail") });
    await app.close();
  });
});

describe("POST /api/email/send", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ success: true, messageId: "msg-1" });
  });

  const jsonHeaders = () => ({ ...auth(), "content-type": "application/json" });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/send",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ to: "a@b.com", subject: "Hi", body: "Hello" }),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 400 (not 200) when a required field is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/send",
      headers: jsonHeaders(),
      payload: JSON.stringify({ to: "a@b.com", subject: "Hi" }),
    });
    expect(res.statusCode).toBe(400);
    expect(sendEmailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 400 (not 200) when sendEmail reports a soft error", async () => {
    sendEmailMock.mockResolvedValue({ error: "Gmail not connected." });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/send",
      headers: jsonHeaders(),
      payload: JSON.stringify({ to: "a@b.com", subject: "Hi", body: "Hello" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Gmail not connected." });
    await app.close();
  });

  it("returns the result on a successful send", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/send",
      headers: jsonHeaders(),
      payload: JSON.stringify({ to: "a@b.com", subject: "Hi", body: "Hello" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, messageId: "msg-1" });
    await app.close();
  });
});
