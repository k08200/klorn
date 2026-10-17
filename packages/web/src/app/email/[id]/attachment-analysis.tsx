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
import { useT } from "../../../lib/i18n";
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
  const { t } = useT();

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
      toast(t("emailDetail.attachment.error.brief"), "error");
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
      toast(t("emailDetail.attachment.error.download"), "error");
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
      toast(
        err instanceof Error ? err.message : t("emailDetail.attachment.error.convertFailed"),
        "error",
      );
    } finally {
      setConverting(null);
    }
  };

  return (
    <section className="mt-5 rounded-xl border border-line bg-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-ink-dim">
          {t("emailDetail.attachment.title")}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-caption text-ink-dim">
            {t("emailDetail.attachment.fileCount", { count: String(attachments.length) })}
          </span>
          <button
            type="button"
            onClick={downloadBrief}
            disabled={downloading === "brief"}
            className="rounded border border-accent/25 bg-accent/10 px-2 py-1 text-caption text-accent-deep transition hover:bg-accent/15 disabled:opacity-50 focus-ring"
          >
            {downloading === "brief"
              ? t("emailDetail.attachment.creatingBrief")
              : t("emailDetail.attachment.downloadBrief")}
          </button>
          <button
            type="button"
            onClick={onReanalyze}
            disabled={reanalyzing}
            className="rounded border border-line bg-surface-hover px-2 py-1 text-caption text-ink-mid transition hover:bg-surface-inset disabled:opacity-50 focus-ring"
          >
            {reanalyzing
              ? t("emailDetail.attachment.analyzing")
              : t("emailDetail.attachment.reanalyze")}
          </button>
          <button
            type="button"
            onClick={onOcr}
            disabled={ocring}
            className="rounded border border-accent/25 bg-accent/10 px-2 py-1 text-caption text-accent-deep transition hover:bg-accent/15 disabled:opacity-50 focus-ring"
          >
            {ocring
              ? t("emailDetail.attachment.runningOcr")
              : t("emailDetail.attachment.ocrVision")}
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="border-t border-line pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-full truncate text-sm font-medium text-ink">
                {attachment.filename}
              </span>
              {attachment.category && (
                <span className="rounded border border-line bg-surface-hover px-1.5 py-0.5 text-caption text-ink-mid">
                  {attachmentCategoryLabel(t, attachment.category)}
                </span>
              )}
              <span className="text-caption text-ink-mid">
                {formatBytes(attachment.size)} ·{" "}
                {attachmentStatusLabel(t, attachment.analysisStatus)}
              </span>
              {attachmentNeedsManualReview(t, attachment) && (
                <span className="rounded border border-rose-400/25 bg-rose-400/10 px-1.5 py-0.5 text-caption text-rose-200">
                  {t("emailDetail.attachment.sourceReview")}
                </span>
              )}
              <button
                type="button"
                onClick={() => downloadAttachment(attachment)}
                disabled={downloading === attachment.id}
                className="rounded border border-line bg-surface-panel px-2 py-0.5 text-caption text-ink-mid transition hover:border-line-strong hover:text-ink-mid disabled:opacity-50 focus-ring"
              >
                {downloading === attachment.id
                  ? t("emailDetail.attachment.downloading")
                  : t("emailDetail.attachment.downloadOriginal")}
              </button>
              <div className="flex items-center gap-1 rounded border border-line bg-surface-panel p-0.5">
                <select
                  value={conversionTargets[attachment.id] ?? defaultConversionTarget(attachment)}
                  onChange={(event) =>
                    setConversionTargets((prev) => ({
                      ...prev,
                      [attachment.id]: event.target.value as AttachmentConversionTarget,
                    }))
                  }
                  className="max-w-20 bg-transparent px-1 py-0.5 text-caption text-ink-mid outline-none"
                  aria-label={t("emailDetail.attachment.conversionFormatAria", {
                    filename: attachment.filename,
                  })}
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
                  className="rounded bg-slate-600 px-2 py-0.5 text-caption font-medium text-white transition hover:bg-slate-700 disabled:opacity-50 focus-ring"
                >
                  {converting?.startsWith(`${attachment.id}:`)
                    ? t("emailDetail.attachment.converting")
                    : t("emailDetail.attachment.convert")}
                </button>
              </div>
            </div>
            {attachment.summary && (
              <p className="mt-2 text-xs leading-relaxed text-ink-mid">{attachment.summary}</p>
            )}
            {attachmentNeedsManualReview(t, attachment) && (
              <p className="mt-2 text-caption leading-relaxed text-rose-200/80">
                {attachmentManualReviewReason(t, attachment)}
              </p>
            )}
            {attachment.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {attachment.keyPoints.map((point, index) => (
                  <li
                    key={`${attachment.id}-${index}`}
                    className="flex gap-1.5 text-xs text-ink-mid"
                  >
                    <span className="text-slate-300">•</span>
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
                      className="rounded border border-line bg-surface-panel px-2 py-1 text-caption text-ink-mid"
                    >
                      {fieldLabel(t, key)}: {String(value)}
                    </span>
                  ),
                )}
              </div>
            )}
            {attachment.textPreview && (
              <details className="mt-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
                <summary className="cursor-pointer text-caption font-medium text-ink-dim">
                  {t("emailDetail.attachment.textPreview")}
                </summary>
                <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-caption leading-relaxed text-ink-dim">
                  {attachment.textPreview}
                </pre>
              </details>
            )}
            {attachment.analysisError && (
              <p className="mt-2 text-caption leading-relaxed text-accent-deep">
                {t("emailDetail.attachment.fallbackPrefix", { reason: attachment.analysisError })}
              </p>
            )}
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setEditingId(editingId === attachment.id ? null : attachment.id)}
                className="rounded border border-line bg-surface-panel px-2 py-1 text-caption text-ink-mid transition hover:border-accent/30 hover:text-accent-deep focus-ring"
              >
                {editingId === attachment.id
                  ? t("emailDetail.attachment.closeEdit")
                  : t("emailDetail.attachment.editAnalysis")}
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
  // Default PDFs to text extraction, not DWG — the backend's own recommender
  // ranks pdf/docx/txt well above dwg (a niche CAD target). DWG stays selectable
  // in the dropdown for the rare engineering-drawing PDF.
  if (name.endsWith(".pdf") || attachment.mimeType.toLowerCase().includes("pdf")) return "txt";
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
  const { t } = useT();

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
          <span className="mb-1 block text-caption uppercase tracking-wider text-ink-mid">
            {t("emailDetail.attachment.form.summaryLabel")}
          </span>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full rounded border border-line bg-surface-raised px-2 py-1.5 text-xs text-ink-mid outline-none focus:border-accent/40"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-caption uppercase tracking-wider text-ink-mid">
            {t("emailDetail.attachment.form.categoryLabel")}
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded border border-line bg-surface-raised px-2 py-1.5 text-xs text-ink-mid outline-none focus:border-accent/40"
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
                {attachmentCategoryLabel(t, value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="block text-caption uppercase tracking-wider text-ink-mid">
            {t("emailDetail.attachment.form.extractedFieldsLabel")}
          </span>
          <button
            type="button"
            onClick={() => setFields((prev) => [...prev, { key: "", value: "" }])}
            className="text-caption text-ink-dim transition hover:text-ink-mid focus-ring"
          >
            {t("emailDetail.attachment.form.addField")}
          </button>
        </div>
        <div className="space-y-1.5">
          {fields.length === 0 && (
            <p className="rounded border border-line bg-surface-raised px-2 py-2 text-caption text-ink-dim">
              {t("emailDetail.attachment.form.noFields")}
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
                placeholder={t("emailDetail.attachment.form.fieldPlaceholder")}
                className="rounded border border-line bg-surface-raised px-2 py-1.5 text-xs text-ink-mid outline-none focus:border-accent/40"
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
                placeholder={t("emailDetail.attachment.form.valuePlaceholder")}
                className="rounded border border-line bg-surface-raised px-2 py-1.5 text-xs text-ink-mid outline-none focus:border-accent/40"
              />
              <button
                type="button"
                onClick={() =>
                  setFields((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
                }
                className="rounded border border-line px-2 py-1.5 text-caption text-ink-dim transition hover:border-rose-400/30 hover:text-rose-200 focus-ring"
              >
                {t("common.delete")}
              </button>
            </div>
          ))}
        </div>
      </div>
      {error && <p className="mt-1 text-caption text-rose-300">{error}</p>}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-accent-solid px-3 py-1.5 text-xs font-medium text-accent-solid-ink transition hover:bg-accent-solid-hover disabled:opacity-50 focus-ring"
        >
          {saving
            ? t("emailDetail.attachment.form.saving")
            : t("emailDetail.attachment.form.saveChanges")}
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

/** `t` is passed in rather than called via useT() here — these are plain
 * helpers, not components, so they cannot use hooks themselves. */
function attachmentCategoryLabel(t: (key: string) => string, category: string): string {
  const labelMap: Record<string, string> = {
    resume: t("emailDetail.attachment.category.resume"),
    profile: t("emailDetail.attachment.category.profile"),
    portfolio: t("emailDetail.attachment.category.portfolio"),
    audition: t("emailDetail.attachment.category.audition"),
    contract: t("emailDetail.attachment.category.contract"),
    invoice: t("emailDetail.attachment.category.invoice"),
    proposal: t("emailDetail.attachment.category.proposal"),
    schedule: t("emailDetail.attachment.category.schedule"),
    image: t("emailDetail.attachment.category.image"),
    document: t("emailDetail.attachment.category.document"),
    other: t("emailDetail.attachment.category.other"),
  };
  return labelMap[category] || category;
}

function attachmentStatusLabel(t: (key: string) => string, status: string): string {
  const labelMap: Record<string, string> = {
    ANALYZED: t("emailDetail.attachment.status.analyzed"),
    FALLBACK: t("emailDetail.attachment.status.fallback"),
    PENDING: t("emailDetail.attachment.status.pending"),
    UNSUPPORTED: t("emailDetail.attachment.status.unsupported"),
  };
  return labelMap[status] || status.toLowerCase();
}

function attachmentNeedsManualReview(
  t: (key: string) => string,
  attachment: EmailAttachment,
): boolean {
  return !!attachmentManualReviewReason(t, attachment);
}

function attachmentManualReviewReason(
  t: (key: string) => string,
  attachment: EmailAttachment,
): string | null {
  if (attachment.analysisStatus === "UNSUPPORTED")
    return t("emailDetail.attachment.reviewReason.unsupported");
  if (attachment.analysisStatus === "PENDING")
    return t("emailDetail.attachment.reviewReason.pending");
  if (attachment.analysisStatus === "FALLBACK")
    return t("emailDetail.attachment.reviewReason.fallback");
  const preview = attachment.textPreview ?? "";
  if (/OCR pending/i.test(preview)) return t("emailDetail.attachment.reviewReason.ocrNeeded");
  if (/no text layer|extraction failed/i.test(preview))
    return t("emailDetail.attachment.reviewReason.extractionIncomplete");
  return null;
}

function fieldLabel(t: (key: string) => string, key: string): string {
  const labelMap: Record<string, string> = {
    name: t("emailDetail.candidateCard.fact.name"),
    role: t("emailDetail.candidateCard.fact.role"),
    contact: t("emailDetail.candidateCard.fact.contact"),
    email: t("nav.email"),
    phone: t("emailDetail.attachment.field.phone"),
    age: t("emailDetail.candidateCard.fact.age"),
    height: t("emailDetail.candidateCard.fact.height"),
    skills: t("emailDetail.attachment.field.skills"),
    links: t("emailDetail.attachment.field.links"),
    deadline: t("emailDetail.attachment.field.deadline"),
    amount: t("emailDetail.attachment.field.amount"),
    availability: t("emailDetail.attachment.field.availability"),
  };
  return labelMap[key] || key;
}
