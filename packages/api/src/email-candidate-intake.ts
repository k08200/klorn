import crypto from "node:crypto";
import { prisma } from "./db.js";
import {
  type AttachmentCandidateProfile,
  buildAttachmentCandidateProfile,
  listEmailAttachments,
} from "./email-attachments.js";

export type CandidateIntakeStatus =
  | "NEEDS_ANALYSIS"
  | "NEEDS_INFO"
  | "READY_TO_REVIEW"
  | "REVIEWING"
  | "CONTACTED"
  | "SHORTLISTED"
  | "REJECTED"
  | "ARCHIVED";

export interface CandidateIntakeView {
  id: string;
  emailId: string;
  status: CandidateIntakeStatus;
  name: string | null;
  role: string | null;
  contact: string | null;
  emailAddress: string | null;
  phone: string | null;
  summary: string;
  confidence: number;
  missingFields: string[];
  evidenceFiles: Array<{ filename: string; category: string | null; summary: string | null }>;
  notes: string | null;
  lastDetectedAt: string;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  const attachments = await listEmailAttachments([input.emailId]);
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
        OR a."filename" ~* '(resume|cv|profile|portfolio|audition|casting|showreel|reel|이력서|프로필|오디션|캐스팅|포트폴리오)'
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
): Promise<Record<string, CandidateIntakeView>> {
  if (emailIds.length === 0 || typeof prisma.$queryRaw !== "function") return {};
  const rows = await prisma.$queryRaw<CandidateIntakeRow[]>`
    SELECT
      "id", "emailId", "status", "name", "role", "contact", "emailAddress", "phone",
      "summary", "confidence", "missingFields", "evidenceFiles", "notes",
      "lastDetectedAt", "reviewedAt", "createdAt", "updatedAt"
    FROM "CandidateIntake"
    WHERE "emailId" = ANY(${emailIds})
  `;
  return Object.fromEntries(rows.map((row) => [row.emailId, serializeCandidateIntake(row)]));
}

export async function listCandidateIntakes(input: {
  userId: string;
  status?: CandidateIntakeStatus | null;
  limit?: number;
}): Promise<CandidateIntakeListItem[]> {
  if (typeof prisma.$queryRaw !== "function") return [];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
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
  return rows.map((row) => ({
    ...serializeCandidateIntake(row),
    email: {
      id: row.emailId,
      from: row.from,
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: row.receivedAt.toISOString(),
      isRead: row.isRead,
    },
  }));
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
  };
}

function parseStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
}

function parseEvidenceFiles(
  value: unknown,
): Array<{ filename: string; category: string | null; summary: string | null }> {
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
      };
    })
    .filter((item): item is { filename: string; category: string | null; summary: string | null } =>
      Boolean(item),
    );
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
