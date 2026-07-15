/**
 * Email candidate intake routes — list / export / bulk-update / per-email PATCH.
 *
 * Split out of routes/email.ts so the candidate intake domain (CSV export,
 * attention filters, status transitions) lives in one place. Registered by
 * emailRoutes() against the same `/api/email` prefix so paths stay byte-identical.
 */

import type { FastifyInstance } from "fastify";
import { getUserId, requireAuth } from "../auth.js";
import { prisma } from "../db.js";
import {
  listCandidateIntakes,
  normalizeCandidateIntakeStatus,
  syncCandidateIntakeForEmail,
  syncRecentCandidateIntakes,
  updateCandidateIntake,
  updateCandidateIntakes,
} from "../mail/email-candidate-intake.js";
import {
  type CandidateIntakeStatus,
  openCommitmentForCandidateTransition,
} from "../pim/candidate-commitments.js";

type CandidateRows = Awaited<ReturnType<typeof listCandidateIntakes>>;

function csvCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ").trim();
  return `"${normalized.replace(/"/g, '""')}"`;
}

function candidateIntakeCsv(rows: CandidateRows): string {
  const header = [
    "status",
    "name",
    "role",
    "contact",
    "email",
    "phone",
    "confidence",
    "duplicate_count",
    "duplicate_reasons",
    "manual_review_files",
    "missing_fields",
    "summary",
    "evidence_files",
    "notes",
    "mail_from",
    "mail_subject",
    "received_at",
    "email_id",
  ];
  const body = rows.map((row) =>
    [
      row.status,
      row.name ?? "",
      row.role ?? "",
      row.contact ?? "",
      row.emailAddress ?? "",
      row.phone ?? "",
      String(Math.round(row.confidence * 100)),
      String(row.duplicateCount),
      row.duplicateReasons.join("; "),
      row.evidenceFiles
        .filter((file) => file.needsManualReview)
        .map((file) => [file.filename, file.reviewReason].filter(Boolean).join(": "))
        .join("; "),
      row.missingFields.join("; "),
      row.summary,
      row.evidenceFiles.map((file) => file.filename).join("; "),
      row.notes ?? "",
      row.email.from,
      row.email.subject,
      row.email.receivedAt,
      row.emailId,
    ]
      .map(csvCell)
      .join(","),
  );
  return `\ufeff${[header.map(csvCell).join(","), ...body].join("\n")}\n`;
}

type CandidateAttentionFilter = "all" | "duplicates" | "manual_review" | "incomplete";

function normalizeCandidateAttentionFilter(value: unknown): CandidateAttentionFilter | null {
  if (value === undefined || value === null || value === "" || value === "all") return "all";
  if (value === "duplicates" || value === "manual_review" || value === "incomplete") {
    return value;
  }
  return null;
}

function filterCandidateIntakes(
  rows: CandidateRows,
  attention: CandidateAttentionFilter,
): CandidateRows {
  if (attention === "all") return rows;
  if (attention === "duplicates") {
    return rows.filter((row) => row.duplicateCount > 1);
  }
  if (attention === "manual_review") {
    return rows.filter((row) => row.evidenceFiles.some((file) => file.needsManualReview));
  }
  if (attention === "incomplete") {
    return rows.filter((row) => row.missingFields.length > 0);
  }
  return rows;
}

export async function registerEmailCandidatesRoutes(app: FastifyInstance) {
  // GET /api/email/candidates/export.csv?status=READY_TO_REVIEW&limit=500
  app.get("/candidates/export.csv", { preHandler: requireAuth }, async (request, reply) => {
    const uid = getUserId(request);
    const { status, limit, refresh, attention } = request.query as {
      status?: string;
      limit?: string;
      refresh?: string;
      attention?: string;
    };
    const normalizedStatus = status ? normalizeCandidateIntakeStatus(status) : null;
    if (status && !normalizedStatus) {
      return reply.code(400).send({ error: "Invalid candidate intake status" });
    }
    const normalizedAttention = normalizeCandidateAttentionFilter(attention);
    if (!normalizedAttention) {
      return reply.code(400).send({ error: "Invalid candidate attention filter" });
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
    if (refresh === "true") {
      await syncRecentCandidateIntakes(uid, safeLimit);
    }
    const candidates = await listCandidateIntakes({
      userId: uid,
      status: normalizedStatus,
      limit: safeLimit,
    });
    const csv = candidateIntakeCsv(filterCandidateIntakes(candidates, normalizedAttention));
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="klorn-candidate-intake.csv"')
      .send(Buffer.from(csv, "utf-8"));
  });

  // POST /api/email/candidates/bulk-status
  app.post("/candidates/bulk-status", { preHandler: requireAuth }, async (request, reply) => {
    const uid = getUserId(request);
    const body =
      (request.body as { emailIds?: unknown; status?: unknown; notes?: string | null }) || {};
    const status = normalizeCandidateIntakeStatus(body.status);
    if (!status) return reply.code(400).send({ error: "Invalid candidate intake status" });
    const emailIds = Array.isArray(body.emailIds)
      ? body.emailIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    if (emailIds.length === 0) return reply.code(400).send({ error: "No candidates selected" });
    if (emailIds.length > 100) {
      return reply.code(400).send({ error: "Bulk update is limited to 100 candidates" });
    }
    const updated = await updateCandidateIntakes({
      userId: uid,
      emailIds,
      status,
      notes: body.notes,
    });
    return { updated, updatedCount: updated.length };
  });

  // GET /api/email/candidates?status=READY_TO_REVIEW&limit=50
  app.get("/candidates", { preHandler: requireAuth }, async (request, reply) => {
    const uid = getUserId(request);
    const { status, limit, refresh, attention } = request.query as {
      status?: string;
      limit?: string;
      refresh?: string;
      attention?: string;
    };
    if (refresh === "true") {
      await syncRecentCandidateIntakes(uid, Number(limit) || 50);
    }
    const normalizedStatus = status ? normalizeCandidateIntakeStatus(status) : null;
    if (status && !normalizedStatus) {
      return reply.code(400).send({ error: "Invalid candidate intake status" });
    }
    const normalizedAttention = normalizeCandidateAttentionFilter(attention);
    if (!normalizedAttention) {
      return reply.code(400).send({ error: "Invalid candidate attention filter" });
    }
    const candidates = await listCandidateIntakes({
      userId: uid,
      status: normalizedStatus,
      limit: Number(limit) || 50,
    });
    return { candidates: filterCandidateIntakes(candidates, normalizedAttention) };
  });

  // PATCH /api/email/:id/candidate-intake
  app.patch("/:id/candidate-intake", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = getUserId(request);
    const body = (request.body as { status?: string; notes?: string | null }) || {};
    const status =
      body.status === undefined ? undefined : normalizeCandidateIntakeStatus(body.status);
    if (body.status !== undefined && !status) {
      return reply.code(400).send({ error: "Invalid candidate intake status" });
    }

    const dbEmail = await prisma.emailMessage.findFirst({
      where: { userId: uid, OR: [{ id }, { gmailId: id }] },
      select: { id: true, threadId: true },
    });
    if (!dbEmail) return reply.code(404).send({ error: "Email not found" });

    // Snapshot the pre-update status so we can detect a real transition.
    const before = await prisma.candidateIntake.findUnique({
      where: { userId_emailId: { userId: uid, emailId: dbEmail.id } },
      select: { status: true },
    });

    let intake = await updateCandidateIntake({
      userId: uid,
      emailId: dbEmail.id,
      status,
      notes: body.notes,
    });
    if (!intake) {
      intake = await syncCandidateIntakeForEmail({ userId: uid, emailId: dbEmail.id });
      if (intake && (status || body.notes !== undefined)) {
        intake = await updateCandidateIntake({
          userId: uid,
          emailId: dbEmail.id,
          status,
          notes: body.notes,
        });
      }
    }
    if (!intake) return reply.code(404).send({ error: "Candidate intake not found" });

    // Open the matching commitment when the status actually changes to a
    // mapped state. Same-status updates are a no-op so a repeated PATCH
    // (idempotent client retry, status pill double-click) cannot spawn
    // duplicates beyond the dedupKey safety net.
    let openedCommitmentId: string | null = null;
    if (status && status !== before?.status) {
      const opened = await openCommitmentForCandidateTransition(
        uid,
        {
          id: intake.id,
          name: intake.name,
          contactEmail: intake.emailAddress,
          emailId: dbEmail.id,
          threadId: dbEmail.threadId ?? null,
        },
        status as CandidateIntakeStatus,
      );
      openedCommitmentId = opened?.id ?? null;
    }

    return { candidateIntake: intake, openedCommitmentId };
  });
}
