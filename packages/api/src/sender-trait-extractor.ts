import { prisma } from "./db.js";
import { asString, asUnitInterval } from "./llm-coerce.js";
import { getUserLlmCredentials } from "./llm-credentials.js";
import { parseLlmJson } from "./llm-json.js";
import { createCompletion, JUDGE_MODEL } from "./openai.js";
import type { ProviderCredentials } from "./providers/index.js";
import type { CandidateTrait } from "./sender-trait-policy.js";
import { TRAIT_KINDS, validateTraitValue } from "./sender-trait-policy.js";
import type { TraitSourceEmail } from "./sender-trait-signature.js";
import { computeTraitSourceSig } from "./sender-trait-signature.js";
import { upsertSenderTrait } from "./sender-trait-store.js";
import { captureError } from "./sentry.js";

interface RawTrait {
  value?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}
type RawResponse = Partial<Record<string, RawTrait>>;

function buildPrompt(emails: TraitSourceEmail[]): string {
  const lines = emails.map((e, i) => `${i}. from=${e.from} | subject=${e.subject} | ${e.snippet}`);
  return `You profile an email SENDER from their recent messages. Return JSON only, shape:
{"relationship":{"value":"investor","confidence":0.0-1.0,"evidence":"short quote"},
 "recurring_intent":{"value":"billing","confidence":0.0-1.0,"evidence":"short quote"}}
relationship is one of: vendor, customer, investor, internal_colleague, recruiter, service_automated, personal, unknown.
recurring_intent is one of: billing, scheduling, newsletter, transactional_receipt, support, sales_outreach, personal_correspondence, none.
evidence MUST be a short verbatim quote from the emails. Omit a key if unsure.

Emails:
${lines.join("\n")}`;
}

/**
 * Extract validated sender traits from a sample of one sender's emails. Returns
 * only candidates whose value is in the taxonomy (hallucinations are dropped).
 * Never throws — an LLM/parse failure yields [] (the caller skips the sender).
 */
export async function extractTraitsFromEmails(
  emails: TraitSourceEmail[],
  opts: { userId?: string; credentials?: ProviderCredentials },
): Promise<CandidateTrait[]> {
  try {
    const response = await createCompletion(
      {
        model: JUDGE_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a strict JSON sender profiler. JSON only, no fences.",
          },
          { role: "user", content: buildPrompt(emails) },
        ],
        response_format: { type: "json_object" },
      },
      {
        ...(opts.userId ? { userId: opts.userId, priority: "background" as const } : {}),
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      },
    );
    const raw = response.choices[0]?.message?.content;
    if (!raw) return [];
    const parsed = parseLlmJson<RawResponse>(raw);

    const out: CandidateTrait[] = [];
    for (const kind of TRAIT_KINDS) {
      const entry = parsed[kind];
      if (!entry) continue;
      const value = validateTraitValue(kind, entry.value);
      // Cap at 200 chars: evidence is a short verbatim quote, the DB column is
      // VARCHAR(300), and an unbounded model quote would otherwise overflow it.
      const evidenceText = asString(entry.evidence).slice(0, 200);
      if (value === null || evidenceText === "") continue;
      out.push({
        factKind: kind,
        factValue: value,
        confidence: asUnitInterval(entry.confidence),
        evidenceText,
      });
    }
    return out;
  } catch (err) {
    console.warn(
      "[TRAITS] extraction failed — skipping sender:",
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, { tags: { scope: "sender-traits.extract" } });
    return [];
  }
}

const SAMPLE_PER_SENDER = 8;
const MAX_SENDERS_PER_RUN = 50;

export interface TraitRunSummary {
  sendersProcessed: number;
  sendersFailed: number;
  /**
   * Total upserts applied this run — counts create AND strengthen AND conflict
   * writes, not only brand-new rows. (A strengthen/conflict is still a DB write.)
   */
  traitsWritten: number;
}

/** Group a user's recent emails by sender and extract traits per sender. */
export async function extractSenderTraitsForUser(userId: string): Promise<TraitRunSummary> {
  const credentials = await getUserLlmCredentials(userId);
  const recent = await prisma.emailMessage.findMany({
    where: { userId, body: { not: null } },
    orderBy: { receivedAt: "desc" },
    take: SAMPLE_PER_SENDER * MAX_SENDERS_PER_RUN,
    select: { from: true, subject: true, snippet: true, labels: true },
  });

  // NOTE (v0): we fetch the recent N emails globally then group by sender, so a
  // very high-volume sender can crowd out senders whose last mail falls outside
  // that window. Per-sender sampling is a future refinement.
  const bySender = new Map<string, typeof recent>();
  for (const e of recent) {
    const list = bySender.get(e.from) ?? [];
    if (list.length < SAMPLE_PER_SENDER) list.push(e);
    bySender.set(e.from, list);
  }

  const senders = [...bySender.entries()].slice(0, MAX_SENDERS_PER_RUN);
  const results = await Promise.allSettled(
    senders.map(async ([sender, sampleRaw]) => {
      const sample = sampleRaw.map((e) => ({
        from: e.from,
        subject: e.subject ?? "",
        snippet: e.snippet ?? "",
        labels: e.labels ?? [],
      }));
      const sourceSig = computeTraitSourceSig(sample);
      // Signature gate: if every stored trait for this sender already carries
      // this exact evidence signature, the sender's recent mail is unchanged —
      // skip the LLM call (idempotent, cost-saving; the AutoBE staleness gate).
      // This read is intentionally outside upsertSenderTrait's transaction: it
      // is a cost optimization, NOT a correctness gate. Concurrency is already
      // prevented by the automation-scheduler advisory lock that serializes
      // this job; the per-trait upsert transaction is the row-level safety net
      // if that lock ever leaks (a duplicate then lands last-write-wins, never
      // corrupt). A weaker-than-it-looks gate, by design.
      const stored = await prisma.senderTrait.findMany({
        where: { userId, sender },
        select: { sourceSig: true },
      });
      if (stored.length > 0 && stored.every((t) => t.sourceSig === sourceSig)) {
        return 0;
      }
      const candidates = await extractTraitsFromEmails(sample, {
        userId,
        ...(credentials ? { credentials } : {}),
      });
      let written = 0;
      for (const candidate of candidates) {
        await upsertSenderTrait({ userId, sender, candidate, sourceSig });
        written++;
      }
      return written;
    }),
  );

  let traitsWritten = 0;
  let sendersFailed = 0;
  results.forEach((r) => {
    if (r.status === "fulfilled") traitsWritten += r.value;
    else {
      sendersFailed++;
      console.warn("[TRAITS] sender failed for", userId, ":", r.reason);
      captureError(r.reason, { tags: { scope: "sender-traits.sender", userId } });
    }
  });
  return { sendersProcessed: senders.length, sendersFailed, traitsWritten };
}

/** Batch entry point for the scheduler — every user with mail. */
export async function extractSenderTraitsForAllUsers(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true } });
  for (const u of users) {
    try {
      await extractSenderTraitsForUser(u.id);
    } catch (err) {
      console.error("[TRAITS] batch failed for user", u.id, err);
      captureError(err, { tags: { scope: "sender-traits.batch", userId: u.id } });
    }
  }
}
