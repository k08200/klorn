/**
 * Outlook mail stored `attachments: []`. The delta poll now lists a message's
 * attachments once (needsAttachmentScan), in Gmail's model: metadata for every
 * file/item attachment, text extracted from readable file attachments through
 * the isolated worker, no bytes stored. Graph is faked at fetch().
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const persistGmailEmail = vi.hoisted(() => vi.fn());
const needsAttachmentScan = vi.hoisted(() => vi.fn());
const extract = vi.hoisted(() => vi.fn());
vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail }));
vi.mock("../mail/attachment-scan-gate.js", () => ({
  needsAttachmentScan,
  wasAttachmentScanned: () => false,
  rememberAttachmentScan: () => undefined,
}));
vi.mock("../mail/attachment-extract-isolated.js", () => ({
  extractAttachmentContentIsolated: extract,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { syncOutlookInbox } = await import("../mail/outlook-sync.js");
const { listOutlookAttachments, fetchOutlookAttachmentBytes } = await import(
  "../mail/outlook-attachments.js"
);

const GRAPH = "https://graph.microsoft.com/v1.0";
const PDF = Buffer.from("%PDF-1.4 invoice");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ATTACHMENTS = {
  value: [
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "att/1+=",
      name: "../invoice.pdf",
      contentType: "application/pdf",
      size: PDF.length,
      isInline: false,
    },
    {
      "@odata.type": "#microsoft.graph.itemAttachment",
      id: "att-2",
      name: "Fwd: plan",
      contentType: null,
      size: 2048,
      isInline: false,
    },
    {
      "@odata.type": "#microsoft.graph.referenceAttachment",
      id: "att-3",
      name: "OneDrive link",
      contentType: null,
      size: 10,
      isInline: false,
    },
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "att-4",
      name: "archive.zip",
      contentType: "application/zip",
      size: 4096,
      isInline: false,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  persistGmailEmail.mockResolvedValue({ emailId: "e", isNew: true });
  needsAttachmentScan.mockResolvedValue(true);
  extract.mockResolvedValue({ text: "invoice total 120", status: "readable" });
});

describe("listOutlookAttachments", () => {
  it("lists file and item attachments, extracts readable files, skips reference links", async () => {
    fetchMock.mockResolvedValueOnce(json(ATTACHMENTS)).mockResolvedValueOnce(new Response(PDF));

    const rows = await listOutlookAttachments("at", "msg/1");

    const [listUrl, listInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(listUrl)).toBe(
      `${GRAPH}/me/messages/msg%2F1/attachments?%24select=id%2Cname%2CcontentType%2Csize%2CisInline`,
    );
    expect(listInit?.headers).toMatchObject({ authorization: "Bearer at" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${GRAPH}/me/messages/msg%2F1/attachments/att%2F1%2B%3D/$value`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // the zip is not readable: no bytes fetched
    expect(extract).toHaveBeenCalledWith(PDF, "invoice.pdf", "application/pdf");
    expect(rows).toEqual([
      {
        gmailAttachmentId: "att/1+=",
        partKey: "att/1+=",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: PDF.length,
        contentId: null,
        contentText: "invoice total 120",
      },
      {
        gmailAttachmentId: "att-2",
        partKey: "att-2",
        filename: "Fwd: plan.eml",
        mimeType: "message/rfc822",
        size: 2048,
        contentId: null,
        contentText: null,
      },
      {
        gmailAttachmentId: "att-4",
        partKey: "att-4",
        filename: "archive.zip",
        mimeType: "application/zip",
        size: 4096,
        contentId: null,
        contentText: null,
      },
    ]);
  });

  it("keeps the row without text when the bytes outgrow the extraction cap", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ value: [ATTACHMENTS.value[0]] }))
      .mockResolvedValueOnce(
        new Response(Buffer.alloc(16), { headers: { "content-length": "9000001" } }),
      );

    const [row] = await listOutlookAttachments("at", "m1");

    expect(extract).not.toHaveBeenCalled();
    expect(row).toMatchObject({ partKey: "att/1+=", contentText: null });
  });

  it("throws when Graph refuses the list (the poll then persists without attachments)", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 500));
    await expect(listOutlookAttachments("at", "m1")).rejects.toThrow(/500/);
  });
});

describe("fetchOutlookAttachmentBytes", () => {
  it("returns the raw bytes, or null past the cap", async () => {
    fetchMock.mockResolvedValueOnce(new Response(PDF));
    expect(await fetchOutlookAttachmentBytes("at", "m1", "a1", 1024)).toEqual({ bytes: PDF });

    fetchMock.mockResolvedValueOnce(new Response(Buffer.alloc(2048)));
    expect(await fetchOutlookAttachmentBytes("at", "m1", "a1", 1024)).toEqual({ tooLarge: true });

    fetchMock.mockResolvedValueOnce(json({}, 404));
    expect(await fetchOutlookAttachmentBytes("at", "m1", "a1", 1024)).toEqual({ status: 404 });
  });
});

describe("syncOutlookInbox attachments", () => {
  const delta = (over: Record<string, unknown>) =>
    json({
      value: [
        {
          id: "imm-1",
          subject: "invoice",
          from: { emailAddress: { address: "a@b.com" } },
          receivedDateTime: "2026-11-01T00:00:00Z",
          body: { content: "see attached" },
          ...over,
        },
      ],
      "@odata.deltaLink": `${GRAPH}/me/delta?token=x`,
    });

  it("asks Graph for hasAttachments and persists the listed rows once", async () => {
    fetchMock
      .mockResolvedValueOnce(delta({ hasAttachments: true }))
      .mockResolvedValueOnce(json({ value: [ATTACHMENTS.value[3]] }));

    await syncOutlookInbox({
      userId: "u1",
      email: "me@outlook.com",
      accessToken: "at",
      linkedInboxAccountId: "acc",
      cursor: null,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("hasAttachments");
    expect(needsAttachmentScan).toHaveBeenCalledWith("u1", "outlook:me@outlook.com:imm-1");
    expect(persistGmailEmail.mock.calls[0]?.[1]?.attachments).toEqual([
      expect.objectContaining({ partKey: "att-4", filename: "archive.zip" }),
    ]);
  });

  it("does not list attachments of a stored row that has them, nor of a message without", async () => {
    needsAttachmentScan.mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(delta({ hasAttachments: true }));
    await syncOutlookInbox({
      userId: "u1",
      email: "me@outlook.com",
      accessToken: "at",
      linkedInboxAccountId: "acc",
      cursor: null,
    });
    fetchMock.mockResolvedValueOnce(delta({ hasAttachments: false }));
    await syncOutlookInbox({
      userId: "u1",
      email: "me@outlook.com",
      accessToken: "at",
      linkedInboxAccountId: "acc",
      cursor: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2); // the two delta pages only
    expect(needsAttachmentScan).toHaveBeenCalledTimes(1);
    for (const call of persistGmailEmail.mock.calls) expect(call[1].attachments).toEqual([]);
  });

  it("lists attachments when a stored delta link predates hasAttachments in $select", async () => {
    fetchMock
      .mockResolvedValueOnce(delta({}))
      .mockResolvedValueOnce(json({ value: [ATTACHMENTS.value[3]] }));

    await syncOutlookInbox({
      userId: "u1",
      email: "me@outlook.com",
      accessToken: "at",
      linkedInboxAccountId: "acc",
      cursor: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=old`,
    });

    expect(persistGmailEmail.mock.calls[0]?.[1]?.attachments).toEqual([
      expect.objectContaining({ partKey: "att-4" }),
    ]);
  });

  it("persists the message without attachments when the list fails", async () => {
    fetchMock
      .mockResolvedValueOnce(delta({ hasAttachments: true }))
      .mockResolvedValueOnce(json({}, 503));

    const result = await syncOutlookInbox({
      userId: "u1",
      email: "me@outlook.com",
      accessToken: "at",
      linkedInboxAccountId: "acc",
      cursor: null,
    });

    expect(persistGmailEmail.mock.calls[0]?.[1]).toMatchObject({
      subject: "invoice",
      attachments: [],
    });
    expect(result.errors).toBe(0);
  });
});
