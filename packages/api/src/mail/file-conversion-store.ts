import crypto from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileConversionQualityReport } from "./file-conversions.js";

const DEFAULT_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredConversionResultMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  target: string | null;
  fileCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface StoredConversionQualityReport extends FileConversionQualityReport {
  id: string;
  createdAt: string;
}

export async function saveConversionResult(input: {
  userId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  target?: string | null;
  fileCount?: number;
}): Promise<StoredConversionResultMeta> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const meta: StoredConversionResultMeta = {
    id,
    filename: safeFilename(input.filename),
    mimeType: input.mimeType || "application/octet-stream",
    size: input.buffer.length,
    target: input.target ?? null,
    fileCount: Math.max(1, Math.floor(input.fileCount ?? 1)),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + conversionResultTtlMs()).toISOString(),
  };
  const dir = userResultDir(input.userId);
  await mkdir(dir, { recursive: true });
  await writeFile(resultFilePath(dir, id, "bin"), input.buffer);
  await writeFile(resultFilePath(dir, id, "json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  return meta;
}

export async function getConversionResult(
  userId: string,
  id: string,
): Promise<{ meta: StoredConversionResultMeta; buffer: Buffer } | null> {
  if (!isSafeId(id)) return null;
  const dir = userResultDir(userId);
  const meta = await findMetaById(dir, id);
  if (!meta) return null;
  if (isExpired(meta)) {
    await removeResultFiles(dir, meta.id);
    return null;
  }
  try {
    const buffer = await readFile(resultFilePath(dir, meta.id, "bin"));
    return { meta, buffer };
  } catch {
    return null;
  }
}

export async function listConversionResults(
  userId: string,
  limit = 20,
): Promise<StoredConversionResultMeta[]> {
  const dir = userResultDir(userId);
  const files = await readdir(dir).catch(() => []);
  const metas: StoredConversionResultMeta[] = [];
  for (const file of files) {
    const meta = await readMetaFile(dir, file);
    if (!meta) continue;
    if (isExpired(meta)) {
      await removeResultFiles(dir, meta.id);
      continue;
    }
    metas.push(meta);
  }
  return metas
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export async function saveConversionQualityReport(
  userId: string,
  report: FileConversionQualityReport,
): Promise<StoredConversionQualityReport> {
  const stored: StoredConversionQualityReport = {
    ...report,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const dir = qualityReportDir(userId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resultFilePath(dir, stored.id, "json"),
    `${JSON.stringify(stored, null, 2)}\n`,
    "utf-8",
  );
  return stored;
}

export async function listConversionQualityReports(
  userId: string,
  limit = 20,
): Promise<StoredConversionQualityReport[]> {
  const dir = qualityReportDir(userId);
  const files = await readdir(dir).catch(() => []);
  const reports: StoredConversionQualityReport[] = [];
  for (const file of files) {
    const report = await readQualityReportFile(dir, file);
    if (report) reports.push(report);
  }
  return reports
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export async function cleanupExpiredConversionResults(userId?: string): Promise<void> {
  const root = conversionStorageRoot();
  const dirs = userId
    ? [userResultDir(userId)]
    : (await readdir(root).catch(() => [])).map((name) => path.join(root, name));
  for (const dir of dirs) {
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;
    const files = await readdir(dir).catch(() => []);
    for (const file of files) {
      const meta = await readMetaFile(dir, file);
      if (meta && isExpired(meta)) await removeResultFiles(dir, meta.id);
    }
  }
}

function conversionStorageRoot(): string {
  return path.resolve(
    process.env.EVE_CONVERSION_STORAGE_DIR?.trim() ||
      path.join(process.cwd(), "data", "file-conversions"),
  );
}

function userResultDir(userId: string): string {
  return safeJoin(conversionStorageRoot(), userStorageKey(userId));
}

function qualityReportDir(userId: string): string {
  return safeJoin(userResultDir(userId), "_quality-reports");
}

function conversionResultTtlMs(): number {
  const value = Number(process.env.EVE_CONVERSION_RESULT_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RESULT_TTL_MS;
}

async function findMetaById(dir: string, id: string): Promise<StoredConversionResultMeta | null> {
  const files = await readdir(dir).catch(() => []);
  for (const file of files) {
    const meta = await readMetaFile(dir, file);
    if (meta?.id === id) return meta;
  }
  return null;
}

async function readMetaFile(dir: string, file: string): Promise<StoredConversionResultMeta | null> {
  const filePath = safeJsonEntryPath(dir, file);
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(
      await readFile(filePath, "utf-8"),
    ) as Partial<StoredConversionResultMeta>;
    if (
      typeof parsed.id !== "string" ||
      !isSafeId(parsed.id) ||
      typeof parsed.filename !== "string" ||
      typeof parsed.mimeType !== "string" ||
      typeof parsed.size !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      filename: parsed.filename,
      mimeType: parsed.mimeType,
      size: parsed.size,
      target: typeof parsed.target === "string" ? parsed.target : null,
      fileCount: typeof parsed.fileCount === "number" ? parsed.fileCount : 1,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function readQualityReportFile(
  dir: string,
  file: string,
): Promise<StoredConversionQualityReport | null> {
  const filePath = safeJsonEntryPath(dir, file);
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(
      await readFile(filePath, "utf-8"),
    ) as Partial<StoredConversionQualityReport>;
    if (
      typeof parsed.id !== "string" ||
      !isSafeId(parsed.id) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.generatedAt !== "string" ||
      typeof parsed.score !== "number" ||
      !Array.isArray(parsed.scenarios)
    ) {
      return null;
    }
    return parsed as StoredConversionQualityReport;
  } catch {
    return null;
  }
}

function isExpired(meta: StoredConversionResultMeta): boolean {
  return Date.parse(meta.expiresAt) <= Date.now();
}

async function removeResultFiles(dir: string, id: string): Promise<void> {
  if (!isSafeId(id)) return;
  await Promise.all([
    rm(resultFilePath(dir, id, "bin"), { force: true }),
    rm(resultFilePath(dir, id, "json"), { force: true }),
  ]);
}

function isSafeId(value: string): boolean {
  return /^[0-9a-f-]{20,80}$/i.test(value);
}

function safeFilename(filename: string): string {
  return (
    path.basename(filename || "converted-file").replace(/[\\/:*?"<>|]+/g, "_") || "converted-file"
  );
}

function userStorageKey(userId: string): string {
  const key = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(key)) throw new Error("Invalid conversion storage key");
  return key;
}

function resultFilePath(dir: string, id: string, extension: "bin" | "json"): string {
  if (!isSafeId(id)) throw new Error("Invalid conversion result id");
  return safeJoin(dir, `${id}.${extension}`);
}

function safeJsonEntryPath(dir: string, file: string): string | null {
  const name = path.basename(file);
  if (name !== file || !/^[0-9a-f-]{20,80}\.json$/i.test(name)) return null;
  return safeJoin(dir, name);
}

function safeJoin(baseDir: string, child: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, child);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Unsafe conversion storage path");
  }
  return resolved;
}
