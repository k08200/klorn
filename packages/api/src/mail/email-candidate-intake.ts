import crypto from "node:crypto";
// The intake wire shapes live in @klorn/contract (they ride on the email
// list response). Re-exported here so intake internals and existing
// importers keep a single source.
import type { CandidateIntakeStatus, CandidateIntakeWire } from "@klorn/contract";
import { prisma } from "../db.js";
import {
  type AttachmentCandidateProfile,
  buildAttachmentCandidateProfile,
  listEmailAttachments,
} from "./email-attachments.js";

export type { CandidateIntakeStatus };

export type CandidateIntakeView = CandidateIntakeWire;

export interface CandidateIntakeListItem extends CandidateIntakeView {
  email: {
    id: string;
    from: string;
    subject: string;
    snippet: string | null;
    receivedAt: string;
    isRead: boolean;
  };
}

interface CandidateIntakeRow {
  id: string;
  emailId: string;
  status: string;
  name: string | null;
  role: string | null;
  contact: string | null;
  emailAddress: string | null;
  phone: string | null;
  summary: string;
  confidence: number;
  missingFields: unknown;
  evidenceFiles: unknown;
  notes: string | null;
  lastDetectedAt: Date;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CandidateIntakeListRow extends CandidateIntakeRow {
  from: string;
  subject: string;
  snippet: string | null;
  receivedAt: Date;
  isRead: boolean;
}

const VALID_STATUSES = new Set<CandidateIntakeStatus>([
  "NEEDS_ANALYSIS",
  "NEEDS_INFO",
  "READY_TO_REVIEW",
  "REVIEWING",
  "CONTACTED",
  "SHORTLISTED",
  "REJECTED",
  "ARCHIVED",
]);

export function normalizeCandidateIntakeStatus(value: unknown): CandidateIntakeStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return VALID_STATUSES.has(normalized as CandidateIntakeStatus)
    ? (normalized as CandidateIntakeStatus)
    : null;
}

export function intakeStatusFromProfile(
  profile: AttachmentCandidateProfile,
): CandidateIntakeStatus {
  if (profile.pipelineStatus === "needs_analysis") return "NEEDS_ANALYSIS";
  if (profile.pipelineStatus === "needs_info") return "NEEDS_INFO";
  return "READY_TO_REVIEW";
}

export async function syncCandidateIntakeForEmail(input: {
  userId: string;
  emailId: string;
}): Promise<CandidateIntakeView | null> {
  const attachments = await listEmailAttachments([input.emailId], input.userId);
  const profile = buildAttachmentCandidateProfile(attachments);
  if (!profile) return null;
  return upsertCandidateIntakeFromProfile({ ...input, profile });
}

export async function syncRecentCandidateIntakes(
  userId: string,
  limit = 25,
): Promise<CandidateIntakeView[]> {
  if (typeof prisma.$queryRaw !== "function") return [];
  const rows = await prisma.$queryRaw<Array<{ emailId: string }>>`
    SELECT a."emailId"
    FROM "EmailAttachment" a
    JOIN "EmailMessage" e ON e."id" = a."emailId"
    WHERE a."userId" = ${userId}
      AND (
        a."category" IN ('resume', 'profile', 'portfolio', 'audition')
        OR a."filename" ~* '(resume|cv|profile|portfolio|audition|casting|showreel|reel|headshot|comp[ _-]?card|self[ _-]?tape|actor|model|performer|이력서|프로필|오디션|캐스팅|포트폴리오|배우|모델|지원서|상반신|전신)'
      )
    GROUP BY a."emailId"
    ORDER BY MAX(e."receivedAt") DESC
    LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `;
  const synced: CandidateIntakeView[] = [];
  for (const row of rows) {
    const intake = await syncCandidateIntakeForEmail({ userId, emailId: row.emailId });
    if (intake) synced.push(intake);
  }
  return synced;
}

export async function upsertCandidateIntakeFromProfile(input: {
  userId: string;
  emailId: string;
  profile: AttachmentCandidateProfile;
}): Promise<CandidateIntakeView | null> {
  if (typeof prisma.$queryRaw !== "function") return null;
  const status = intakeStatusFromProfile(input.profile);
  const id = crypto.randomUUID();
  const missingFields = JSON.stringify(input.profile.missingFields);
  const evidenceFiles = JSON.stringify(input.profile.evidenceFiles);
  const rows = await prisma.$queryRaw<CandidateIntakeRow[]>`
    INSERT INTO "CandidateIntake" (
      "id", "userId", "emailId", "status", "name", "role", "contact", "emailAddress",
      "phone", "summary", "confidence", "missingFields", "evidenceFiles",
      "lastDetectedAt", "updatedAt"
    )
    VALUES (
      ${id}, ${input.userId}, ${input.emailId}, ${status}, ${input.profile.name},
      ${input.profile.role}, ${input.profile.contact}, ${input.profile.email},
      ${input.profile.phone}, ${input.profile.summary}, ${input.profile.confidence},
      CAST(${missingFields} AS JSONB), CAST(${evidenceFiles} AS JSONB), NOW(), NOW()
    )
    ON CONFLICT ("userId", "emailId") DO UPDATE SET
      "status" = CASE
        WHEN "CandidateIntake"."status" IN ('NEEDS_ANALYSIS', 'NEEDS_INFO', 'READY_TO_REVIEW')
          THEN EXCLUDED."status"
        ELSE "CandidateIntake"."status"
      END,
      "name" = COALESCE(EXCLUDED."name", "CandidateIntake"."name"),
      "role" = COALESCE(EXCLUDED."role", "CandidateIntake"."role"),
      "contact" = COALESCE(EXCLUDED."contact", "CandidateIntake"."contact"),
      "emailAddress" = COALESCE(EXCLUDED."emailAddress", "CandidateIntake"."emailAddress"),
      "phone" = COALESCE(EXCLUDED."phone", "CandidateIntake"."phone"),
      "summary" = EXCLUDED."summary",
      "confidence" = EXCLUDED."confidence",
      "missingFields" = EXCLUDED."missingFields",
      "evidenceFiles" = EXCLUDED."evidenceFiles",
      "lastDetectedAt" = NOW(),
      "updatedAt" = NOW()
    RETURNING
      "id", "emailId", "status", "name", "role", "contact", "emailAddress", "phone",
      "summary", "confidence", "missingFields", "evidenceFiles", "notes",
      "lastDetectedAt", "reviewedAt", "createdAt", "updatedAt"
  `;
  return rows[0] ? serializeCandidateIntake(rows[0]) : null;
}

export async function listCandidateIntakesByEmail(
  emailIds: string[],
  userId: string,
): Promise<Record<string, CandidateIntakeView>> {
  if (emailIds.length === 0 || typeof prisma.$queryRaw !== "function") return {};
  // userId is part of the WHERE (not just the caller's emailId set) so this can
  // never return another user's intake rows even if a caller passes foreign ids.
  const rows = await prisma.$queryRaw<CandidateIntakeRow[]>`
    SELECT
      "id", "emailId", "status", "name", "role", "contact", "emailAddress", "phone",
      "summary", "confidence", "missingFields", "evidenceFiles", "notes",
      "lastDetectedAt", "reviewedAt", "createdAt", "updatedAt"
    FROM "CandidateIntake"
    WHERE "userId" = ${userId} AND "emailId" = ANY(${emailIds})
  `;
  return Object.fromEntries(rows.map((row) => [row.emailId, serializeCandidateIntake(row)]));
}

export async function listCandidateIntakes(input: {
  userId: string;
  status?: CandidateIntakeStatus | null;
  limit?: number;
}): Promise<CandidateIntakeListItem[]> {
  if (typeof prisma.$queryRaw !== "function") return [];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const rows = await prisma.$queryRaw<CandidateIntakeListRow[]>`
    SELECT
      c."id", c."emailId", c."status", c."name", c."role", c."contact",
      c."emailAddress", c."phone", c."summary", c."confidence", c."missingFields",
      c."evidenceFiles", c."notes", c."lastDetectedAt", c."reviewedAt",
      c."createdAt", c."updatedAt",
      e."from", e."subject", e."snippet", e."receivedAt", e."isRead"
    FROM "CandidateIntake" c
    JOIN "EmailMessage" e ON e."id" = c."emailId"
    WHERE c."userId" = ${input.userId}
      AND (${input.status}::text IS NULL OR c."status" = ${input.status})
    ORDER BY c."updatedAt" DESC
    LIMIT ${limit}
  `;
  return attachDuplicateHints(
    rows.map((row) => ({
      ...serializeCandidateIntake(row),
      email: {
        id: row.emailId,
        from: row.from,
        subject: row.subject,
        snippet: row.snippet,
        receivedAt: row.receivedAt.toISOString(),
        isRead: row.isRead,
      },
    })),
  );
}

export async function updateCandidateIntakes(input: {
  userId: string;
  emailIds: string[];
  status: CandidateIntakeStatus;
  notes?: string | null;
}): Promise<CandidateIntakeView[]> {
  if (input.emailIds.length === 0 || typeof prisma.$queryRaw !== "function") return [];
  const emailIds = Array.from(new Set(input.emailIds)).slice(0, 100);
  const rows = await prisma.$queryRaw<CandidateIntakeRow[]>`
    UPDATE "CandidateIntake"
    SET
      "status" = ${input.status},
      "notes" = CASE WHEN ${input.notes === undefined} THEN "notes" ELSE ${input.notes ?? null} END,
      "reviewedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "userId" = ${input.userId}
      AND "emailId" = ANY(${emailIds})
    RETURNING
      "id", "emailId", "status", "name", "role", "contact", "emailAddress", "phone",
      "summary", "confidence", "missingFields", "evidenceFiles", "notes",
      "lastDetectedAt", "reviewedAt", "createdAt", "updatedAt"
  `;
  return rows.map(serializeCandidateIntake);
}

export async function updateCandidateIntake(input: {
  userId: string;
  emailId: string;
  status?: CandidateIntakeStatus | null;
  notes?: string | null;
}): Promise<CandidateIntakeView | null> {
  if (typeof prisma.$queryRaw !== "function") return null;
  const rows = await prisma.$queryRaw<CandidateIntakeRow[]>`
    UPDATE "CandidateIntake"
    SET
      "status" = COALESCE(${input.status}, "status"),
      "notes" = CASE WHEN ${input.notes === undefined} THEN "notes" ELSE ${input.notes ?? null} END,
      "reviewedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "userId" = ${input.userId}
      AND "emailId" = ${input.emailId}
    RETURNING
      "id", "emailId", "status", "name", "role", "contact", "emailAddress", "phone",
      "summary", "confidence", "missingFields", "evidenceFiles", "notes",
      "lastDetectedAt", "reviewedAt", "createdAt", "updatedAt"
  `;
  return rows[0] ? serializeCandidateIntake(rows[0]) : null;
}

function serializeCandidateIntake(row: CandidateIntakeRow): CandidateIntakeView {
  return {
    id: row.id,
    emailId: row.emailId,
    status: normalizeCandidateIntakeStatus(row.status) ?? "READY_TO_REVIEW",
    name: row.name,
    role: row.role,
    contact: row.contact,
    emailAddress: row.emailAddress,
    phone: row.phone,
    summary: row.summary,
    confidence: row.confidence,
    missingFields: parseStringArray(row.missingFields),
    evidenceFiles: parseEvidenceFiles(row.evidenceFiles),
    notes: row.notes,
    lastDetectedAt: row.lastDetectedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    duplicateKey: null,
    duplicateCount: 1,
    duplicateEmailIds: [],
    duplicateReasons: [],
  };
}

export function attachDuplicateHints<T extends CandidateIntakeView>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  const reasonsByKey = new Map<string, string[]>();

  for (const row of rows) {
    const identity = candidateIdentity(row);
    if (!identity) continue;
    const group = groups.get(identity.key) ?? [];
    group.push(row);
    groups.set(identity.key, group);
    reasonsByKey.set(identity.key, identity.reasons);
  }

  return rows.map((row) => {
    const identity = candidateIdentity(row);
    if (!identity) return row;
    const group = groups.get(identity.key) ?? [];
    if (group.length <= 1) return row;
    return {
      ...row,
      duplicateKey: identity.key,
      duplicateCount: group.length,
      duplicateEmailIds: group
        .map((item) => item.emailId)
        .filter((emailId) => emailId !== row.emailId),
      duplicateReasons: reasonsByKey.get(identity.key) ?? identity.reasons,
    };
  });
}

export function candidateIdentity(
  row: Pick<CandidateIntakeView, "emailAddress" | "phone" | "contact" | "name" | "role">,
): { key: string; reasons: string[] } | null {
  const email = normalizeEmail(row.emailAddress) || normalizeEmail(row.contact);
  if (email) return { key: `email:${email}`, reasons: ["same_email"] };

  const phone = normalizePhone(row.phone) || normalizePhone(row.contact);
  if (phone && phone.length >= 7) return { key: `phone:${phone}`, reasons: ["same_phone"] };

  const name = normalizeLooseText(row.name);
  if (!name) return null;
  const role = normalizeLooseText(row.role);
  if (role) return { key: `name_role:${name}:${role}`, reasons: ["same_name_and_role"] };
  return { key: `name:${name}`, reasons: ["same_name"] };
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  return email ? email.toLowerCase() : null;
}

function normalizePhone(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length < 7) return null;
  if (digits.startsWith("82") && digits.length > 9) return `0${digits.slice(2)}`;
  return digits;
}

function normalizeLooseText(value: string | null | undefined): string | null {
  const normalized = value
    ?.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
  return normalized && normalized.length >= 2 ? normalized : null;
}

function parseStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
}

function parseEvidenceFiles(value: unknown): Array<{
  filename: string;
  category: string | null;
  summary: string | null;
  analysisStatus: string | null;
  needsManualReview: boolean;
  reviewReason: string | null;
}> {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return {
        filename: typeof record.filename === "string" ? record.filename : "attachment",
        category: typeof record.category === "string" ? record.category : null,
        summary: typeof record.summary === "string" ? record.summary : null,
        analysisStatus: typeof record.analysisStatus === "string" ? record.analysisStatus : null,
        needsManualReview: record.needsManualReview === true,
        reviewReason: typeof record.reviewReason === "string" ? record.reviewReason : null,
      };
    })
    .filter(
      (
        item,
      ): item is {
        filename: string;
        category: string | null;
        summary: string | null;
        analysisStatus: string | null;
        needsManualReview: boolean;
        reviewReason: string | null;
      } => Boolean(item),
    );
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
