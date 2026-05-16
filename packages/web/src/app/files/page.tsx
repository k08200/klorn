"use client";

import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { API_BASE, authHeaders } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

type FileConversionTarget =
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

const TARGETS: Array<{ value: FileConversionTarget; label: string; hint: string }> = [
  { value: "pdf", label: "PDF", hint: "Document output" },
  { value: "docx", label: "DOCX", hint: "Word document" },
  { value: "xlsx", label: "XLSX", hint: "Table format" },
  { value: "png", label: "PNG", hint: "Image" },
  { value: "jpg", label: "JPG", hint: "Image" },
  { value: "webp", label: "WEBP", hint: "Image" },
  { value: "dwg", label: "DWG", hint: "PDF drawings" },
  { value: "dxf", label: "DXF", hint: "CAD exchange" },
  { value: "txt", label: "TXT", hint: "Extracted text" },
  { value: "md", label: "MD", hint: "Summary doc" },
  { value: "json", label: "JSON", hint: "Structured data" },
  { value: "yaml", label: "YAML", hint: "Config exchange" },
  { value: "csv", label: "CSV", hint: "Field table" },
  { value: "html", label: "HTML", hint: "Web document" },
  { value: "xml", label: "XML", hint: "Exchange doc" },
  { value: "svg", label: "SVG", hint: "Summary image" },
  { value: "rtf", label: "RTF", hint: "Rich text" },
];

interface ConversionCapability {
  target: FileConversionTarget;
  label: string;
  mode: "builtin" | "external";
  available: boolean;
  description: string;
}

interface FilePreview {
  filename: string;
  mimeType: string;
  size: number;
  status: "readable" | "metadata" | "unsupported";
  quality: "readable" | "metadata" | "unsupported";
  preview: string | null;
  recommendations?: Array<{
    target: FileConversionTarget;
    reason: string;
    priority: number;
  }>;
}

interface ConversionEngineStatus {
  id: string;
  label: string;
  category: "layout" | "image" | "cad";
  available: boolean;
  source: "env" | "auto" | "missing";
  executable: string | null;
  targets: FileConversionTarget[];
  targetStatuses: Array<{ target: FileConversionTarget; available: boolean }>;
  detail: string;
  setupHint: string;
}

interface QualityScenarioResult {
  id: string;
  label: string;
  category: "builtin" | "layout" | "image" | "cad";
  status: "pass" | "warn" | "blocked" | "fail";
  detail: string;
  durationMs: number;
  outputBytes?: number;
}

interface QualityReport {
  id?: string;
  score: number;
  generatedAt: string;
  createdAt?: string;
  passed: number;
  warned: number;
  blocked: number;
  failed: number;
  scenarios: QualityScenarioResult[];
}

interface ConversionAlternative {
  target: FileConversionTarget;
  reason: string;
}

interface ConversionHistoryItem {
  id: string;
  resultId: string;
  filename: string;
  target: FileConversionTarget;
  fileCount: number;
  createdAt: string;
  expiresAt?: string;
  size?: number;
}

interface StoredConversionResult {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  target: string | null;
  fileCount: number;
  createdAt: string;
  expiresAt: string;
}

export default function FilesPage() {
  return (
    <AuthGuard>
      <FileConverter />
    </AuthGuard>
  );
}

function FileConverter() {
  const [files, setFiles] = useState<File[]>([]);
  const [target, setTarget] = useState<FileConversionTarget>("pdf");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ConversionCapability[]>([]);
  const [engines, setEngines] = useState<ConversionEngineStatus[]>([]);
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
  const [qualityHistory, setQualityHistory] = useState<QualityReport[]>([]);
  const [qualityRunning, setQualityRunning] = useState(false);
  const [conversionAlternatives, setConversionAlternatives] = useState<ConversionAlternative[]>([]);
  const [previews, setPreviews] = useState<FilePreview[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [history, setHistory] = useState<ConversionHistoryItem[]>([]);

  const loadHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/files/results`, { headers: authHeaders() });
      if (!res.ok) {
        setHistory(readConversionHistory());
        return;
      }
      const data = (await res.json()) as { results?: StoredConversionResult[] };
      const items = (data.results ?? []).map(storedResultToHistoryItem);
      setHistory(items);
      writeConversionHistory(items);
    } catch (err) {
      captureClientError(err, { scope: "files.history" });
      setHistory(readConversionHistory());
    }
  };

  const loadQualityHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/files/quality-tests`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = (await res.json()) as { reports?: QualityReport[] };
      const reports = data.reports ?? [];
      setQualityHistory(reports);
      setQualityReport(reports[0] ?? null);
    } catch (err) {
      captureClientError(err, { scope: "files.quality-history" });
    }
  };

  useEffect(() => {
    fetch(`${API_BASE}/api/files/conversions`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            capabilities?: ConversionCapability[];
            engines?: ConversionEngineStatus[];
          } | null,
        ) => {
          setCapabilities(data?.capabilities ?? []);
          setEngines(data?.engines ?? []);
        },
      )
      .catch((err) => captureClientError(err, { scope: "files.conversions" }));
    loadHistory();
    loadQualityHistory();
  }, []);

  const runQualityTests = async () => {
    if (qualityRunning) return;
    setQualityRunning(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/files/quality-tests/run`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Quality test failed: ${res.status}`);
      }
      const report = (await res.json()) as QualityReport;
      setQualityReport(report);
      setQualityHistory((prev) =>
        [report, ...prev.filter((item) => item.id !== report.id)].slice(0, 6),
      );
    } catch (err) {
      captureClientError(err, { scope: "files.quality-tests" });
      setMessage(err instanceof Error ? err.message : "Could not run quality tests.");
    } finally {
      setQualityRunning(false);
    }
  };

  const convert = async () => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    setConversionAlternatives([]);
    try {
      if (files.length > 1) {
        const payloadFiles = await Promise.all(
          files.map(async (file) => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            contentBase64: await readFileAsDataUrl(file),
          })),
        );
        const res = await fetch(`${API_BASE}/api/files/convert-batch`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ files: payloadFiles, targetFormat: target }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            alternatives?: ConversionAlternative[];
          } | null;
          setConversionAlternatives(validAlternatives(body?.alternatives));
          throw new Error(body?.error || `ZIP conversion failed: ${res.status}`);
        }
        const filename =
          filenameFromContentDisposition(res.headers.get("Content-Disposition")) ||
          `jigeum-converted-${target}.zip`;
        await downloadResponseBlob(res, filename);
        rememberConversionResult({
          resultId: conversionIdFromHeaders(res.headers),
          filename,
          target,
          fileCount: files.length,
        });
        await loadHistory();
        setMessage(`Created a ZIP with ${files.length} converted files.`);
        return;
      }

      const file = files[0];
      const contentBase64 = await readFileAsDataUrl(file);
      const res = await fetch(`${API_BASE}/api/files/convert`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64,
          targetFormat: target,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          alternatives?: ConversionAlternative[];
        } | null;
        setConversionAlternatives(validAlternatives(body?.alternatives));
        throw new Error(`${file.name}: ${body?.error || `Conversion failed: ${res.status}`}`);
      }
      const filename =
        filenameFromContentDisposition(res.headers.get("Content-Disposition")) ||
        convertedFilename(file.name, target);
      await downloadResponseBlob(res, filename);
      rememberConversionResult({
        resultId: conversionIdFromHeaders(res.headers),
        filename,
        target,
        fileCount: 1,
      });
      await loadHistory();
      setMessage(`Converted ${file.name} to ${target.toUpperCase()}.`);
    } catch (err) {
      captureClientError(err, {
        scope: "files.convert",
        target,
        filenames: files.map((file) => file.name),
      });
      setMessage(err instanceof Error ? err.message : "File conversion failed.");
    } finally {
      setBusy(false);
    }
  };

  const rememberConversionResult = (input: {
    resultId: string | null;
    filename: string;
    target: FileConversionTarget;
    fileCount: number;
  }) => {
    if (!input.resultId) return;
    const nextItem: ConversionHistoryItem = {
      id: `${input.resultId}-${Date.now()}`,
      resultId: input.resultId,
      filename: input.filename,
      target: input.target,
      fileCount: input.fileCount,
      createdAt: new Date().toISOString(),
    };
    setHistory((prev) => {
      const next = [nextItem, ...prev].slice(0, 8);
      writeConversionHistory(next);
      return next;
    });
  };

  const downloadHistoryItem = async (item: ConversionHistoryItem) => {
    try {
      const res = await fetch(`${API_BASE}/api/files/results/${item.resultId}/download`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        throw new Error("This conversion result expired. Convert it again.");
      }
      await downloadResponseBlob(res, item.filename);
    } catch (err) {
      captureClientError(err, { scope: "files.history.download", resultId: item.resultId });
      setMessage(err instanceof Error ? err.message : "Could not download the previous result.");
    }
  };

  const loadPreviews = async (nextFiles: File[]) => {
    setPreviewing(true);
    setPreviews([]);
    try {
      const previewItems = await Promise.all(
        nextFiles.slice(0, 8).map(async (file) => {
          const contentBase64 = await readFileAsDataUrl(file);
          const res = await fetch(`${API_BASE}/api/files/preview`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
              contentBase64,
            }),
          });
          if (!res.ok) {
            return {
              filename: file.name,
              mimeType: file.type || "application/octet-stream",
              size: file.size,
              status: "unsupported" as const,
              quality: "unsupported" as const,
              preview: "Could not generate a preview.",
            };
          }
          return (await res.json()) as FilePreview;
        }),
      );
      setPreviews(previewItems);
    } catch (err) {
      captureClientError(err, { scope: "files.preview" });
    } finally {
      setPreviewing(false);
    }
  };

  const selectedCapability = capabilities.find((item) => item.target === target);
  const selectedTargetUnavailable =
    selectedCapability?.mode === "external" && selectedCapability.available === false;
  const selectedFileNames = files.map((file) => file.name).join(", ");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-8 text-stone-100">
      <div className="mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-light">
          File tools
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">File conversion</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
          Choose files, then pick the output format you need.
        </p>
      </div>

      <section className="mb-4 rounded-lg border border-white/10 bg-[#11161A] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400">
              Conversion engine status
            </h2>
            <p className="mt-1 text-xs text-stone-600">
              Check engine connectivity and source preservation before conversion.
            </p>
          </div>
          <button
            type="button"
            onClick={runQualityTests}
            disabled={qualityRunning}
            className="rounded-md border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-stone-300 transition hover:border-accent/30 hover:text-accent-dim disabled:cursor-not-allowed disabled:opacity-50"
          >
            {qualityRunning ? "Testing..." : "Run quality tests"}
          </button>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {engines.map((engine) => (
            <div
              key={engine.id}
              className="rounded-md border border-white/10 bg-[#090B10] px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-stone-200">{engine.label}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] ${engineStatusClass(engine)}`}
                >
                  {engineStatusLabel(engine)}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-stone-500">{engine.detail}</p>
              <p className="mt-1 truncate text-[10px] text-stone-700">
                {engine.executable || engine.setupHint}
              </p>
            </div>
          ))}
          {engines.length === 0 && <p className="text-xs text-stone-600">Loading engine status.</p>}
        </div>
        {qualityReport && (
          <div className="mt-4 rounded-lg border border-white/10 bg-[#090B10] p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-stone-200">
                Quality score {qualityReport.score}
              </p>
              <p className="text-[10px] text-stone-600">
                Passed {qualityReport.passed} · Blocked {qualityReport.blocked} · Failed{" "}
                {qualityReport.failed}
              </p>
            </div>
            <div className="space-y-1.5">
              {qualityReport.scenarios.map((scenario) => (
                <div
                  key={scenario.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-800/60 pt-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-stone-300">{scenario.label}</p>
                    <p className="truncate text-[10px] text-stone-600">{scenario.detail}</p>
                  </div>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] ${qualityStatusClass(scenario.status)}`}
                  >
                    {qualityStatusLabel(scenario.status)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {qualityHistory.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {qualityHistory.slice(0, 6).map((report) => (
              <button
                key={report.id ?? report.generatedAt}
                type="button"
                onClick={() => setQualityReport(report)}
                className={`rounded border px-2 py-1 text-[10px] transition ${
                  (qualityReport?.id ?? qualityReport?.generatedAt) ===
                  (report.id ?? report.generatedAt)
                    ? "border-accent/40 bg-accent/10 text-accent-dim"
                    : "border-white/10 bg-[#090B10] text-stone-500 hover:border-accent/30 hover:text-accent-muted"
                }`}
              >
                {report.score} ·{" "}
                {new Date(report.createdAt ?? report.generatedAt).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-white/10 bg-[#11161A] p-4 shadow-2xl shadow-black/10">
        <label className="block rounded-lg border border-dashed border-white/15 bg-[#090B10] px-4 py-8 text-center transition hover:border-accent/35">
          <input
            type="file"
            multiple
            aria-label="Choose files to convert"
            className="sr-only"
            onChange={(event) => {
              const nextFiles = Array.from(event.target.files ?? []);
              setFiles(nextFiles);
              setConversionAlternatives([]);
              if (nextFiles.length === 1) {
                setTarget(recommendedTargetForFile(nextFiles[0]));
              } else if (nextFiles.some((file) => file.name.toLowerCase().endsWith(".pdf"))) {
                setTarget("pdf");
              }
              setMessage(null);
              loadPreviews(nextFiles);
            }}
          />
          <span className="block text-sm font-medium text-stone-200">
            {files.length > 0 ? `${files.length} files selected` : "Choose files to convert"}
          </span>
          <span className="mt-1 block text-xs text-stone-500">
            Convert PDFs, docs, text, tables, images, and drawings into the format you need.
          </span>
          {selectedFileNames && (
            <span className="mx-auto mt-2 block max-w-2xl truncate text-[11px] text-stone-600">
              {selectedFileNames}
            </span>
          )}
        </label>

        {(previewing || previews.length > 0) && (
          <div className="mt-4 rounded-lg border border-white/10 bg-[#090B10] p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                Preview
              </h2>
              {previewing && <span className="text-[11px] text-[#7DD3FC]">Extracting...</span>}
            </div>
            <div className="space-y-2">
              {previews.map((preview) => (
                <div
                  key={preview.filename}
                  className="rounded border border-white/10 bg-[#11161A] px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="max-w-full truncate text-xs font-medium text-stone-200">
                      {preview.filename}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${qualityClass(preview.quality)}`}
                    >
                      {qualityLabel(preview.quality)}
                    </span>
                    <span className="text-[10px] text-stone-600">
                      {preview.mimeType} · {formatBytes(preview.size)}
                    </span>
                  </div>
                  {preview.preview && (
                    <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-5 text-stone-500">
                      {preview.preview}
                    </pre>
                  )}
                  {preview.recommendations && preview.recommendations.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {preview.recommendations.slice(0, 4).map((item) => (
                        <button
                          key={`${preview.filename}-${item.target}`}
                          type="button"
                          onClick={() => setTarget(item.target)}
                          className={`rounded border px-2 py-1 text-[10px] transition ${
                            target === item.target
                              ? "border-accent/45 bg-accent/15 text-accent-dim"
                              : "border-white/10 bg-[#090B10] text-stone-400 hover:border-accent/30 hover:text-accent-dim"
                          }`}
                          title={item.reason}
                        >
                          Use {item.target.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 grid gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {TARGETS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setTarget(option.value)}
              className={`rounded-lg border px-3 py-2 text-left transition ${
                target === option.value
                  ? "border-accent/45 bg-accent/15 text-accent-dim"
                  : "border-white/10 bg-[#090B10] text-stone-400 hover:border-accent/30 hover:text-accent-dim"
              }`}
            >
              <span className="block text-xs font-semibold">{option.label}</span>
              <span className="mt-0.5 block text-[10px] text-stone-500">{option.hint}</span>
              {capabilityBadge(capabilities.find((item) => item.target === option.value))}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs leading-5 text-stone-500">
            {selectedTargetUnavailable
              ? `${selectedCapability.description} Server conversion engine connection is required.`
              : selectedCapability
                ? selectedCapability.description
                : "Choose a conversion target for this file type."}
          </p>
          <button
            type="button"
            onClick={convert}
            disabled={files.length === 0 || busy || selectedTargetUnavailable}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-[#190B07] transition hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-50"
          >
            {selectedTargetUnavailable
              ? "Engine required"
              : busy
                ? "Converting..."
                : files.length > 1
                  ? "Convert to ZIP"
                  : "Convert"}
          </button>
        </div>
        {message && (
          <p className="mt-3 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs leading-5 text-stone-300">
            {message}
          </p>
        )}
        {conversionAlternatives.length > 0 && (
          <div className="mt-3 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2">
            <p className="text-[11px] font-medium text-accent-dim">Suggested alternatives</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {conversionAlternatives.map((item) => (
                <button
                  key={item.target}
                  type="button"
                  onClick={() => {
                    setTarget(item.target);
                    setMessage(`Try again as ${item.target.toUpperCase()}.`);
                    setConversionAlternatives([]);
                  }}
                  className="rounded border border-accent/25 bg-black/20 px-2 py-1 text-[10px] text-accent-dim transition hover:border-accent-muted/50"
                  title={item.reason}
                >
                  {item.target.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="mt-5 rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Recent conversions
            </h2>
            <span className="text-[10px] text-stone-600">Stored conversion results</span>
          </div>
          <div className="space-y-2">
            {history.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone-800/70 bg-black/15 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-stone-200">{item.filename}</p>
                  <p className="mt-0.5 text-[10px] text-stone-600">
                    {item.target.toUpperCase()} · {item.fileCount} files ·{" "}
                    {new Date(item.createdAt).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {item.size ? ` · ${formatBytes(item.size)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => downloadHistoryItem(item)}
                  className="rounded border border-stone-700/70 bg-stone-950/45 px-2 py-1 text-[10px] text-stone-400 transition hover:border-[#7DD3FC]/30 hover:text-sky-200"
                >
                  Download again
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

async function downloadResponseBlob(res: Response, fallbackFilename: string) {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    filenameFromContentDisposition(res.headers.get("Content-Disposition")) || fallbackFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function capabilityBadge(capability: ConversionCapability | undefined) {
  if (!capability) return null;
  const label =
    capability.mode === "builtin"
      ? "Built in"
      : capability.available
        ? "Engine connected"
        : "Engine needed";
  return (
    <span
      className={`mt-1 inline-flex rounded border px-1.5 py-0.5 text-[9px] ${
        capability.mode === "builtin" || capability.available
          ? "border-accent/25 bg-accent/10 text-accent-muted"
          : "border-accent/25 bg-accent/10 text-accent-muted"
      }`}
    >
      {label}
    </span>
  );
}

function engineStatusLabel(engine: ConversionEngineStatus): string {
  if (!engine.available) return "Needs setup";
  if (engine.source === "env") return "Configured";
  return "Auto detected";
}

function engineStatusClass(engine: ConversionEngineStatus): string {
  if (!engine.available) return "border-accent/25 bg-accent/10 text-accent-muted";
  if (engine.source === "env") return "border-accent/25 bg-accent/10 text-accent-muted";
  return "border-[#7DD3FC]/25 bg-[#7DD3FC]/10 text-sky-200";
}

function qualityStatusLabel(status: QualityScenarioResult["status"]): string {
  if (status === "pass") return "Pass";
  if (status === "warn") return "Warn";
  if (status === "blocked") return "Blocked";
  return "Failed";
}

function qualityStatusClass(status: QualityScenarioResult["status"]): string {
  if (status === "pass") return "border-accent/25 bg-accent/10 text-accent-muted";
  if (status === "warn") return "border-accent/25 bg-accent/10 text-accent-muted";
  if (status === "blocked") return "border-stone-600/60 bg-stone-900/70 text-stone-400";
  return "border-rose-400/25 bg-rose-400/10 text-rose-200";
}

function qualityLabel(quality: FilePreview["quality"]): string {
  if (quality === "readable") return "Text extracted";
  if (quality === "metadata") return "Metadata";
  return "Limited extraction";
}

function qualityClass(quality: FilePreview["quality"]): string {
  if (quality === "readable") return "border-accent/25 bg-accent/10 text-accent-muted";
  if (quality === "metadata") return "border-accent/25 bg-accent/10 text-accent-muted";
  return "border-rose-400/25 bg-rose-400/10 text-rose-200";
}

function recommendedTargetForFile(file: File): FileConversionTarget {
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  if (mime.startsWith("image/")) {
    if (mime.includes("jpeg") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "jpg";
    if (mime.includes("webp") || name.endsWith(".webp")) return "webp";
    return "png";
  }
  if (mime.includes("spreadsheet") || /\.(xlsx|xls|csv|tsv)$/.test(name)) return "xlsx";
  if (mime.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (mime.includes("word") || /\.(docx|doc|hwp|hwpx|rtf)$/.test(name)) return "docx";
  return "md";
}

function storedResultToHistoryItem(result: StoredConversionResult): ConversionHistoryItem {
  return {
    id: result.id,
    resultId: result.id,
    filename: result.filename,
    target: isConversionTarget(result.target) ? result.target : targetFromFilename(result.filename),
    fileCount: result.fileCount,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
    size: result.size,
  };
}

function isConversionTarget(value: string | null): value is FileConversionTarget {
  return TARGETS.some((target) => target.value === value);
}

function targetFromFilename(filename: string): FileConversionTarget {
  const ext = filename.toLowerCase().split(".").pop();
  const candidate = ext ?? null;
  return isConversionTarget(candidate) ? candidate : "pdf";
}

function validAlternatives(value: ConversionAlternative[] | undefined): ConversionAlternative[] {
  return Array.isArray(value)
    ? value
        .filter((item) => item && isConversionTarget(item.target))
        .map((item) => ({ target: item.target, reason: String(item.reason || "") }))
        .slice(0, 3)
    : [];
}

const CONVERSION_HISTORY_KEY = "jigeum-file-conversion-history";
const LEGACY_CONVERSION_HISTORY_KEY = "eve-file-conversion-history";

function conversionIdFromHeaders(headers: Headers): string | null {
  return headers.get("X-Jigeum-Conversion-Id") ?? headers.get("X-Eve-Conversion-Id");
}

function readConversionHistory(): ConversionHistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw =
      localStorage.getItem(CONVERSION_HISTORY_KEY) ||
      localStorage.getItem(LEGACY_CONVERSION_HISTORY_KEY) ||
      "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is ConversionHistoryItem =>
            item &&
            typeof item.id === "string" &&
            typeof item.resultId === "string" &&
            typeof item.filename === "string" &&
            typeof item.target === "string" &&
            typeof item.fileCount === "number" &&
            typeof item.createdAt === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function writeConversionHistory(items: ConversionHistoryItem[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONVERSION_HISTORY_KEY, JSON.stringify(items));
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function convertedFilename(filename: string, target: FileConversionTarget): string {
  const clean = filename.replace(/[\\/:*?"<>|]+/g, "_") || "file";
  const base = clean.includes(".") ? clean.slice(0, clean.lastIndexOf(".")) : clean;
  return `${base || "file"}.${target}`;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}
