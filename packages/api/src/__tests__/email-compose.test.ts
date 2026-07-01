import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";

// Spy on the Gmail send boundary so no real network/OAuth is touched.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));

vi.mock("../gmail.js", () => ({
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
vi.mock("../email-sync.js", () => ({ syncEmailByGmailId: vi.fn() }));

// requireAuth touches user + device rows. A user with no devices is a legacy
// session that auth lets through; null sessionsInvalidatedAt means not revoked.
vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: "user-1", sessionsInvalidatedAt: null })) },
    device: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
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
});
