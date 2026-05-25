"use client";

/**
 * Attachment analysis surface for the email detail page — the file list,
 * per-file download/convert/OCR controls, and the inline correction form.
 *
 * Split out of page.tsx so the attachment domain (~300 lines of UI plus
 * ~100 lines of formatters and target metadata) lives in one place.
 * Sibling to atoms.tsx / toolbar.tsx — page.tsx imports `AttachmentAnalysis`
 * and renders it; the form is private to this file.
 */

import { useState } from "react";
import { useToast } from "../../../components/toast";
import { API_BASE, authHeaders } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";
import { formatBytes } from "./atoms";
import type { EmailAttachment } from "./types";

export type AttachmentConversionTarget =
  | "txt"
  | "md"
  | "json"
  | "yaml"
  | "csv"
  | "html"
  | "xml"
  | "svg"
  | "rtf"
  | "pdf"
  | "docx"
  | "xlsx"
  | "png"
  | "jpg"
  | "webp"
  | "dwg"
  | "dxf";

export function AttachmentAnalysis({
  emailId,
  attachments,
  onReanalyze,
  onOcr,
  onSaveCorrection,
  reanalyzing,
  ocring,
  savingCorrectionId,
}: {
  emailId: string;
  attachments: EmailAttachment[];
  onReanalyze: () => void;
  onOcr: () => void;
  onSaveCorrection: (
    attachment: EmailAttachment,
    patch: {
      summary: string;
      category: string;
      extractedFields: Record<string, string | number | boolean | null>;
    },
  ) => void;
  reanalyzing: boolean;
  ocring: boolean;
  savingCorrectionId: string | null;
}) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [converting, setConverting] = useState<string | null>(null);
  const [conversionTargets, setConversionTargets] = useState<
    Record<string, AttachmentConversionTarget>
  >({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const { toast } = useToast();

  const downloadBrief = async () => {
    if (downloading) return;
    setDownloading("brief");
    try {
      const res = await fetch(`${API_BASE}/api/email/${emailId}/attachments/brief`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`brief download failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "klorn-attachment-brief.txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      captureClientError(err, { scope: "email.attachment.brief.download", emailId });
      toast("Could not create the attachment brief.", "error");
    } finally {
      setDownloading(null);
    }
  };

  const downloadAttachment = async (attachment: EmailAttachment) => {
    if (downloading) return;
    setDownloading(attachment.id);
    try {
      const res = await fetch(
        `${API_BASE}/api/email/${emailId}/attachments/${attachment.id}/download`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.filename || "attachment";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      captureClientError(err, { scope: "email.attachment.download", attachmentId: attachment.id });
      toast("Could not download the original attachment. Check Gmail connection.", "error");
    } finally {
      setDownloading(null);
    }
  };

  const convertAttachment = async (attachment: EmailAttachment) => {
    const target = conversionTargets[attachment.id] ?? defaultConversionTarget(attachment);
    const conversionKey = `${attachment.id}:${target}`;
    if (converting) return;
    setConverting(conversionKey);
    try {
      const res = await fetch(
        `${API_BASE}/api/email/${emailId}/attachments/${attachment.id}/convert`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ targetFormat: target }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        throw new Error(body?.error || `convert failed: ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        filenameFromContentDisposition(res.headers.get("Content-Disposition")) ||
        convertedFilename(attachment.filename, target);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      captureClientError(err, {
        scope: "email.attachment.convert",
        attachmentId: attachment.id,
        target,
      });
      toast(err instanceof Error ? err.message : "Attachment conversion failed.", "error");
    } finally {
      setConverting(null);
    }
  };

  return (
    <section className="mt-5 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#7DD3FC]">
          Attachment analysis
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-stone-500">{attachments.length} files</span>
          <button
            type="button"
            onClick={downloadBrief}
            disabled={downloading === "brief"}
            className="rounded border border-accent/25 bg-accent/10 px-2 py-1 text-[11px] text-accent-muted transition hover:bg-accent/15 disabled:opacity-50"
          >
            {downloading === "brief" ? "Creating..." : "Download brief"}
          </button>
          <button
            type="button"
            onClick={onReanalyze}
            disabled={reanalyzing}
            className="rounded border border-[#7DD3FC]/25 bg-[#7DD3FC]/10 px-2 py-1 text-[11px] text-sky-200 transition hover:bg-[#7DD3FC]/15 disabled:opacity-50"
          >
            {reanalyzing ? "Analyzing..." : "Reanalyze"}
          </button>
          <button
            type="button"
            onClick={onOcr}
            disabled={ocring}
            className="rounded border border-accent/25 bg-accent/10 px-2 py-1 text-[11px] text-accent-muted transition hover:bg-accent/15 disabled:opacity-50"
          >
            {ocring ? "Running OCR..." : "OCR/vision"}
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="border-t border-sky-500/15 pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-full truncate text-sm font-medium text-stone-100">
                {attachment.filename}
              </span>
              {attachment.category && (
                <span className="rounded border border-[#7DD3FC]/30 bg-[#7DD3FC]/10 px-1.5 py-0.5 text-[10px] text-sky-200">
                  {attachmentCategoryLabel(attachment.category)}
                </span>
              )}
              <span className="text-[11px] text-stone-600">
                {formatBytes(attachment.size)} · {attachmentStatusLabel(attachment.analysisStatus)}
              </span>
              {attachmentNeedsManualReview(attachment) && (
                <span className="rounded border border-rose-400/25 bg-rose-400/10 px-1.5 py-0.5 text-[10px] text-rose-200">
                  Source review
                </span>
              )}
              <button
                type="button"
                onClick={() => downloadAttachment(attachment)}
                disabled={downloading === attachment.id}
                className="rounded border border-stone-700/70 bg-stone-950/45 px-2 py-0.5 text-[10px] text-stone-400 transition hover:border-[#7DD3FC]/30 hover:text-sky-200 disabled:opacity-50"
              >
                {downloading === attachment.id ? "Downloading" : "Download original"}
              </button>
              <div className="flex items-center gap-1 rounded border border-stone-700/60 bg-stone-950/45 p-0.5">
                <select
                  value={conversionTargets[attachment.id] ?? defaultConversionTarget(attachment)}
                  onChange={(event) =>
                    setConversionTargets((prev) => ({
                      ...prev,
                      [attachment.id]: event.target.value as AttachmentConversionTarget,
                    }))
                  }
                  className="max-w-20 bg-transparent px-1 py-0.5 text-[10px] text-stone-400 outline-none"
                  aria-label={`${attachment.filename} conversion format`}
                >
                  {ATTACHMENT_CONVERSION_TARGETS.map((target) => (
                    <option key={target.value} value={target.value}>
                      {target.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => convertAttachment(attachment)}
                  disabled={
                    converting ===
                    `${attachment.id}:${conversionTargets[attachment.id] ?? defaultConversionTarget(attachment)}`
                  }
                  className="rounded bg-[#7DD3FC] px-2 py-0.5 text-[10px] font-medium text-stone-950 transition hover:bg-sky-200 disabled:opacity-50"
                >
                  {converting?.startsWith(`${attachment.id}:`) ? "Converting" : "Convert"}
                </button>
              </div>
            </div>
            {attachment.summary && (
              <p className="mt-2 text-xs leading-relaxed text-stone-300">{attachment.summary}</p>
            )}
            {attachmentNeedsManualReview(attachment) && (
              <p className="mt-2 text-[11px] leading-relaxed text-rose-200/80">
                {attachmentManualReviewReason(attachment)}
              </p>
            )}
            {attachment.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {attachment.keyPoints.map((point, index) => (
                  <li
                    key={`${attachment.id}-${index}`}
                    className="flex gap-1.5 text-xs text-stone-400"
                  >
                    <span className="text-[#7DD3FC]/80">•</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            )}
            {Object.keys(attachment.extractedFields).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(attachment.extractedFields).map(([key, value]) =>
                  value === null || value === "" ? null : (
                    <span
                      key={key}
                      className="rounded border border-stone-700/60 bg-stone-950/45 px-2 py-1 text-[11px] text-stone-400"
                    >
                      {fieldLabel(key)}: {String(value)}
                    </span>
                  ),
                )}
              </div>
            )}
            {attachment.textPreview && (
              <details className="mt-2 rounded-lg border border-stone-800/70 bg-black/15 px-3 py-2">
                <summary className="cursor-pointer text-[11px] font-medium text-stone-500">
                  Converted text preview
                </summary>
                <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-stone-500">
                  {attachment.textPreview}
                </pre>
              </details>
            )}
            {attachment.analysisError && (
              <p className="mt-2 text-[11px] leading-relaxed text-accent/70">
                Processed with fallback analysis: {attachment.analysisError}
              </p>
            )}
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setEditingId(editingId === attachment.id ? null : attachment.id)}
                className="rounded border border-stone-700/70 bg-stone-950/45 px-2 py-1 text-[10px] text-stone-400 transition hover:border-accent/30 hover:text-accent-muted"
              >
                {editingId === attachment.id ? "Close edit" : "Edit analysis"}
              </button>
            </div>
            {editingId === attachment.id && (
              <AttachmentCorrectionForm
                attachment={attachment}
                saving={savingCorrectionId === attachment.id}
                onSave={(patch) => {
                  onSaveCorrection(attachment, patch);
                  setEditingId(null);
                }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Private helpers ─────────────────────────────────────────────────────

const ATTACHMENT_CONVERSION_TARGETS: Array<{ value: AttachmentConversionTarget; label: string }> = [
  { value: "txt", label: "TXT" },
  { value: "md", label: "MD" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "csv", label: "CSV" },
  { value: "html", label: "HTML" },
  { value: "xml", label: "XML" },
  { value: "svg", label: "SVG" },
  { value: "rtf", label: "RTF" },
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "DOCX" },
  { value: "xlsx", label: "XLSX" },
  { value: "png", label: "PNG" },
  { value: "jpg", label: "JPG" },
  { value: "webp", label: "WEBP" },
  { value: "dwg", label: "DWG" },
  { value: "dxf", label: "DXF" },
];

function defaultConversionTarget(attachment: EmailAttachment): AttachmentConversionTarget {
  const name = attachment.filename.toLowerCase();
  if (name.endsWith(".pdf") || attachment.mimeType.toLowerCase().includes("pdf")) return "dwg";
  if (attachment.mimeType.toLowerCase().startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(name)) {
    return name.endsWith(".jpg") || name.endsWith(".jpeg")
      ? "jpg"
      : name.endsWith(".webp")
        ? "webp"
        : "png";
  }
  if (attachment.textPreview) return "txt";
  return "json";
}

function convertedFilename(filename: string, target: AttachmentConversionTarget): string {
  const clean = filename.replace(/[\\/:*?"<>|]+/g, "_") || "attachment";
  const base = clean.includes(".") ? clean.slice(0, clean.lastIndexOf(".")) : clean;
  return `${base || "attachment"}.${target}`;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const match = value.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

function AttachmentCorrectionForm({
  attachment,
  saving,
  onSave,
}: {
  attachment: EmailAttachment;
  saving: boolean;
  onSave: (patch: {
    summary: string;
    category: string;
    extractedFields: Record<string, string | number | boolean | null>;
  }) => void;
}) {
  const [summary, setSummary] = useState(attachment.summary ?? "");
  const [category, setCategory] = useState(attachment.category ?? "document");
  const [fields, setFields] = useState<Array<{ key: string; value: string }>>(() =>
    Object.entries(attachment.extractedFields ?? {}).map(([key, value]) => ({
      key,
      value: value === null ? "" : String(value),
    })),
  );
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const extractedFields: Record<string, string | number | boolean | null> = {};
    for (const field of fields) {
      const key = field.key.trim();
      if (!key) continue;
      extractedFields[key] = coerceFieldValue(field.value);
    }
    setError(null);
    onSave({ summary, category, extractedFields });
  };

  return (
    <div className="mt-3 rounded-lg border border-accent/15 bg-accent/5 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-stone-600">
            Summary
          </span>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-stone-600">
            Category
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
          >
            {[
              "resume",
              "profile",
              "portfolio",
              "audition",
              "contract",
              "invoice",
              "proposal",
              "schedule",
              "image",
              "document",
              "other",
            ].map((value) => (
              <option key={value} value={value}>
                {attachmentCategoryLabel(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="block text-[10px] uppercase tracking-wider text-stone-600">
            Extracted fields
          </span>
          <button
            type="button"
            onClick={() => setFields((prev) => [...prev, { key: "", value: "" }])}
            className="text-[11px] text-[#7DD3FC] transition hover:text-sky-200"
          >
            Add field
          </button>
        </div>
        <div className="space-y-1.5">
          {fields.length === 0 && (
            <p className="rounded border border-stone-800/70 bg-black/15 px-2 py-2 text-[11px] text-stone-500">
              No extracted fields yet. Add any needed value manually.
            </p>
          )}
          {fields.map((field, index) => (
            <div
              key={`${index}-${field.key}`}
              className="grid gap-1.5 sm:grid-cols-[150px_1fr_auto]"
            >
              <input
                value={field.key}
                onChange={(event) =>
                  setFields((prev) =>
                    prev.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, key: event.target.value } : item,
                    ),
                  )
                }
                placeholder="Field"
                className="rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
              />
              <input
                value={field.value}
                onChange={(event) =>
                  setFields((prev) =>
                    prev.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
                placeholder="Value"
                className="rounded border border-stone-700/60 bg-black/20 px-2 py-1.5 text-xs text-stone-300 outline-none focus:border-orange-500/40"
              />
              <button
                type="button"
                onClick={() =>
                  setFields((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
                }
                className="rounded border border-stone-700/60 px-2 py-1.5 text-[11px] text-stone-500 transition hover:border-rose-400/30 hover:text-rose-200"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-stone-950 transition hover:bg-accent-muted disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function coerceFieldValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numeric = Number(trimmed.replace(/,/g, ""));
  if (Number.isFinite(numeric) && /^-?\d+(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return numeric;
  }
  return value;
}

function attachmentCategoryLabel(category: string): string {
  const labelMap: Record<string, string> = {
    resume: "Resume",
    profile: "Profile",
    portfolio: "Portfolio",
    audition: "Audition",
    contract: "Contract",
    invoice: "Invoice",
    proposal: "Proposal",
    schedule: "Schedule",
    image: "Image",
    document: "Document",
    other: "Other",
  };
  return labelMap[category] || category;
}

function attachmentStatusLabel(status: string): string {
  const labelMap: Record<string, string> = {
    ANALYZED: "Analyzed",
    FALLBACK: "Fallback",
    PENDING: "Pending",
    UNSUPPORTED: "Limited extraction",
  };
  return labelMap[status] || status.toLowerCase();
}

function attachmentNeedsManualReview(attachment: EmailAttachment): boolean {
  return !!attachmentManualReviewReason(attachment);
}

function attachmentManualReviewReason(attachment: EmailAttachment): string | null {
  if (attachment.analysisStatus === "UNSUPPORTED")
    return "Text extraction is limited, so source review is needed.";
  if (attachment.analysisStatus === "PENDING") return "Analysis is still pending.";
  if (attachment.analysisStatus === "FALLBACK")
    return "Fallback analysis was used after AI analysis failed. Source review is recommended.";
  const preview = attachment.textPreview ?? "";
  if (/OCR pending/i.test(preview)) return "This image needs OCR or source review.";
  if (/no text layer|extraction failed/i.test(preview))
    return "Automatic text extraction is incomplete, so source review is needed.";
  return null;
}

function fieldLabel(key: string): string {
  const labelMap: Record<string, string> = {
    name: "Name",
    role: "Role",
    contact: "Contact",
    email: "Email",
    phone: "Phone",
    age: "Age",
    height: "Height",
    skills: "Skills",
    links: "Links",
    deadline: "Deadline",
    amount: "Amount",
    availability: "Availability",
  };
  return labelMap[key] || key;
}
