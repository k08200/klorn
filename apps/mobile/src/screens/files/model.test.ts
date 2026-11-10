import { describe, expect, it } from "vitest";
import { MOCK_DRIVE_FILES, mockAttachmentMail } from "../../api/mock/fixtures-hub";
import {
  attachmentDigest,
  attachmentItemId,
  filterBySource,
  formatSize,
  fromAttachment,
  fromDrive,
  matchesSearch,
  openActionOf,
  safeHttpsUrl,
  senderName,
  sortItems,
  tileOf,
  uploadProblemOf,
} from "./model";

const NOW = new Date("2026-10-16T10:28:00+09:00");
const mail = mockAttachmentMail(NOW.getTime()).flatMap(({ email }) =>
  (email.attachments ?? []).map((a) =>
    fromAttachment({
      ...a,
      from: email.from,
      subject: email.subject,
      date: email.date,
      inboxId: email.linkedInboxAccountId,
    }),
  ),
);
const drive = MOCK_DRIVE_FILES.map((f) => fromDrive(f, null));
const all = [...drive, ...mail];

describe("files", () => {
  it("tiles by type, never trusting the name alone", () => {
    expect(tileOf("계약서_v3.pdf", null)).toEqual({ label: "PDF", kind: "pdf" });
    expect(tileOf("2026 Q4 예산.xlsx", null).kind).toBe("sheet");
    expect(tileOf("IR 덱.key", null)).toEqual({ label: "KEY", kind: "slides" });
    expect(tileOf("scan", "image/png")).toEqual({ label: "PNG", kind: "image" });
    expect(tileOf("README", null).label).toBe("FILE");
  });

  it("sorts newest first or by name, and filters by source", () => {
    expect(sortItems(all, "recent", "ko-KR")[0]?.name).toBe("계약서_v3_한빛파트너스.pdf");
    expect(sortItems(all, "name", "en")[0]?.name).toBe("10월_결제내역.pdf");
    expect(filterBySource(all, "GOOGLE").map((i) => i.id)).toEqual(["drv-budget"]);
    expect(filterBySource(all, "MAIL")).toHaveLength(7);
  });

  it("searches attachments by name, summary and sender; leaves drive rows to the server", () => {
    expect(mail.filter((i) => matchesSearch(i, "해지")).map((i) => i.name)).toEqual([
      "계약서_v3_한빛파트너스.pdf",
    ]);
    expect(mail.filter((i) => matchesSearch(i, "김도윤"))).toHaveLength(1);
    expect(drive.every((i) => matchesSearch(i, "zzz"))).toBe(true);
  });

  it("opens Klorn files by download, Google files by https link, attachments in their mail", () => {
    expect(openActionOf(drive[0] ?? mail[0]!)).toEqual({
      kind: "link",
      href: "https://docs.google.com/spreadsheets/d/1AbCbudget/edit",
    });
    expect(openActionOf(drive[1]!)).toEqual({ kind: "download", id: "drv-ir" });
    expect(openActionOf(mail[0]!)).toEqual({ kind: "mail", emailId: "email-contract" });
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://x.example")).toBeNull();
    expect(safeHttpsUrl("https://u:p@x.example")).toBeNull();
  });

  it("digests this week's attachments by category (the artboard card)", () => {
    const digest = attachmentDigest(all, NOW);
    expect(digest.total).toBe(7);
    expect(digest.byCategory).toEqual([
      { category: "contract", count: 2 },
      { category: "resume", count: 3 },
      { category: "invoice", count: 2 },
    ]);
  });

  it("formats sizes, sender names, route ids and upload refusals", () => {
    expect(formatSize(2.1 * 1024 ** 3, "en")).toBe("2.1 GB");
    expect(formatSize(null, "en")).toBe("");
    expect(senderName("박서연 <s@x.example>")).toBe("박서연");
    expect(attachmentItemId("att:1/2")).toBe("a-att_1_2");
    expect(uploadProblemOf(null, 413)).toBe("too-large");
    expect(uploadProblemOf("Storage quota exceeded", 409)).toBe("quota-exceeded");
    expect(uploadProblemOf("quota not configured", 409)).toBe("quota-not-configured");
  });
});
