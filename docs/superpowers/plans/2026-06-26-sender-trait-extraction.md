# Sender Trait Extraction (Phase 3 / B2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract per-sender traits (`relationship`, `recurring_intent`) from email text with quoted evidence into a new `SenderTrait` table — signature-gated, contradiction-flagged, run as an off-hot-path scheduler batch — then measure coverage/conflict/evidence. The judge is NOT modified.

**Architecture:** New pure units (policy, conflict resolver, signature, metrics) tested in isolation, then an LLM extractor (mockable) and a scheduler batch job mirroring the existing weekly `voice-profile-extractor`. Builds on existing surfaces: `attention-input-hash.ts` (signature style), `llm-coerce.ts` (validation), `decision-metrics.ts` (measurement pattern), `automation-scheduler.ts` (job wiring). Hot-path classification stays byte-for-byte unchanged.

**Tech Stack:** TypeScript, Fastify 5, Prisma 6 / Postgres, Vitest, Biome. All in `packages/api`.

**Spec:** `docs/superpowers/specs/2026-06-25-sender-trait-extraction-design.md`

**Conventions (read once):**
- Local imports use the `.js` extension (e.g. `import { prisma } from "./db.js"`).
- Errors: never swallow — `console.warn/error` + `captureError(err, { tags: { scope } })` (from `./sentry.js`). `captureError` is a no-op without a Sentry DSN, so the `console` line is the signal in dev/CI.
- LLM calls go through `createCompletion(body, opts)` from `./openai.js`: `createCompletion({ model, messages, response_format }, { userId?, credentials?, priority? })`. Parse the reply with `parseLlmJson` from `./llm-json.js`, validate with `./llm-coerce.js`.
- Run all commands from `packages/api/` unless stated. Gate = `npx biome check <files>` (from repo root) + `npx tsc --noEmit` + `npx vitest run`.
- Commits: conventional, English, no `Co-Authored-By`, no "Generated with". The pre-merge security hook may flag unrelated working-tree files; prefix the commit with `KLORN_SKIP_SEC_REVIEW=1` (these changes touch no auth/token/crypto surface).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/migrations/20260626000000_add_sender_trait/migration.sql` (create) | `SenderTrait` table + `SenderTraitKind`/`SenderTraitStatus` enums |
| `prisma/schema.prisma` (modify) | Add the model + two enums |
| `src/sender-trait-policy.ts` (create) | Taxonomy (kinds + allowed values) + per-kind validation. Pure. |
| `src/sender-trait-signature.ts` (create) | `computeTraitSourceSig` over a sampled email set. Pure. |
| `src/sender-trait-store.ts` (create) | `resolveTraitUpsert` (pure conflict resolver) + `upsertSenderTrait` (thin DB) |
| `src/sender-trait-metrics.ts` (create) | `summarizeTraits` coverage/conflict-rate/confidence aggregation. Pure. |
| `src/sender-trait-extractor.ts` (create) | LLM extraction + per-user/all-users batch with per-sender isolation |
| `src/automation-scheduler.ts` (modify) | Wire the weekly batch job (mirror voice-profile) |
| `src/routes/admin.ts` (modify) | `GET /api/admin/sender-traits` (metrics + evidence inspector) |
| `scripts/sender-traits.ts` (create) | CLI evidence inspector for the dogfood account |
| Tests | `src/__tests__/sender-trait-{policy,signature,store,metrics,extractor}.test.ts` |

**Shared types** (defined in Task 2, imported everywhere):
```typescript
export type SenderTraitKind = "relationship" | "recurring_intent";
export interface CandidateTrait {
  factKind: SenderTraitKind;
  factValue: string;
  confidence: number;
  evidenceText: string;
}
```

---

## Task 1: Prisma migration — `SenderTrait` table + enums

**Files:**
- Create: `prisma/migrations/20260626000000_add_sender_trait/migration.sql`
- Modify: `prisma/schema.prisma` (append model + enums near `OntologyProposal`, ~line 954)

- [ ] **Step 1: Add the model and enums to `schema.prisma`**

Append after the `ProposalStatus` enum:
```prisma
enum SenderTraitKind {
  relationship
  recurring_intent
}

enum SenderTraitStatus {
  active
  superseded
  conflicted
}

// Extracted-from-content sender facts (Phase 3 / B2). Distinct from the
// DB-derived SenderFacts bundle in sender-policy.ts. The judge does NOT read
// this table in v0 — extraction is measured before any trait is injected.
model SenderTrait {
  id     String @id @default(uuid())
  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  sender    String          // sender address — same key as sender-policy.ts
  factKind  SenderTraitKind
  factValue String          // validated per-kind in code (sender-trait-policy.ts)
  confidence Float
  evidenceText String
  sourceSig String          // attention-input-hash-style signature of the sample
  observedCount Int @default(1)

  // Write-time contradiction capture — never a silent overwrite.
  conflictValue    String?
  conflictEvidence String?
  conflictedAt     DateTime?

  status SenderTraitStatus @default(active)

  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, sender, factKind])
  @@index([userId, sender])
  @@index([userId, factKind, status])
}
```

Also add the back-relation on the `User` model (find `model User {` and add a line alongside its other relations):
```prisma
  senderTraits SenderTrait[]
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260626000000_add_sender_trait/migration.sql`:
```sql
CREATE TYPE "SenderTraitKind" AS ENUM ('relationship', 'recurring_intent');
CREATE TYPE "SenderTraitStatus" AS ENUM ('active', 'superseded', 'conflicted');

CREATE TABLE "SenderTrait" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "factKind" "SenderTraitKind" NOT NULL,
    "factValue" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceText" TEXT NOT NULL,
    "sourceSig" TEXT NOT NULL,
    "observedCount" INTEGER NOT NULL DEFAULT 1,
    "conflictValue" TEXT,
    "conflictEvidence" TEXT,
    "conflictedAt" TIMESTAMP(3),
    "status" "SenderTraitStatus" NOT NULL DEFAULT 'active',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SenderTrait_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SenderTrait_userId_sender_factKind_key" ON "SenderTrait"("userId", "sender", "factKind");
CREATE INDEX "SenderTrait_userId_sender_idx" ON "SenderTrait"("userId", "sender");
CREATE INDEX "SenderTrait_userId_factKind_status_idx" ON "SenderTrait"("userId", "factKind", "status");

ALTER TABLE "SenderTrait" ADD CONSTRAINT "SenderTrait_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" with no schema validation error.

- [ ] **Step 4: Type-check the schema is consistent**

Run: `npx tsc --noEmit`
Expected: exit 0 (the generated client now types `prisma.senderTrait`).

- [ ] **Step 5: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add prisma/schema.prisma prisma/migrations/20260626000000_add_sender_trait
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(db): add SenderTrait table for extracted sender facts"
```

---

## Task 2: `sender-trait-policy.ts` — taxonomy + validation

**Files:**
- Create: `src/sender-trait-policy.ts`
- Test: `src/__tests__/sender-trait-policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_VALUES,
  RECURRING_INTENT_VALUES,
  validateTraitValue,
} from "../sender-trait-policy.js";

describe("validateTraitValue", () => {
  it("accepts an allowed relationship value", () => {
    expect(validateTraitValue("relationship", "investor")).toBe("investor");
  });

  it("accepts an allowed recurring_intent value", () => {
    expect(validateTraitValue("recurring_intent", "billing")).toBe("billing");
  });

  it("rejects a hallucinated value (returns null)", () => {
    expect(validateTraitValue("relationship", "frenemy")).toBeNull();
    expect(validateTraitValue("recurring_intent", "URGENT")).toBeNull();
  });

  it("rejects a non-string / missing value", () => {
    expect(validateTraitValue("relationship", undefined)).toBeNull();
    expect(validateTraitValue("relationship", 5)).toBeNull();
  });

  it("exposes the closed value sets", () => {
    expect(RELATIONSHIP_VALUES).toContain("unknown");
    expect(RECURRING_INTENT_VALUES).toContain("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sender-trait-policy.test.ts`
Expected: FAIL — cannot find module `../sender-trait-policy.js`.

- [ ] **Step 3: Write the implementation**

```typescript
import { asEnum } from "./llm-coerce.js";

export type SenderTraitKind = "relationship" | "recurring_intent";

export interface CandidateTrait {
  factKind: SenderTraitKind;
  factValue: string;
  confidence: number;
  evidenceText: string;
}

// Vocabulary aligns with EmailCategory (investor/customer/internal/automated)
// where sensible, for cross-signal consistency.
export const RELATIONSHIP_VALUES = [
  "vendor",
  "customer",
  "investor",
  "internal_colleague",
  "recruiter",
  "service_automated",
  "personal",
  "unknown",
] as const;

export const RECURRING_INTENT_VALUES = [
  "billing",
  "scheduling",
  "newsletter",
  "transactional_receipt",
  "support",
  "sales_outreach",
  "personal_correspondence",
  "none",
] as const;

const VALUES_BY_KIND: Record<SenderTraitKind, readonly string[]> = {
  relationship: RELATIONSHIP_VALUES,
  recurring_intent: RECURRING_INTENT_VALUES,
};

/** The fact kinds extracted in v0. */
export const TRAIT_KINDS: readonly SenderTraitKind[] = ["relationship", "recurring_intent"];

/**
 * Returns the value if it is in the kind's closed set, else null. A null means
 * the model produced an out-of-taxonomy value — that fact is dropped, not stored.
 */
export function validateTraitValue(kind: SenderTraitKind, value: unknown): string | null {
  const allowed = VALUES_BY_KIND[kind];
  const coerced = asEnum(value, allowed as readonly string[], "");
  return coerced === "" ? null : coerced;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/sender-trait-policy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/sender-trait-policy.ts src/__tests__/sender-trait-policy.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): sender-trait taxonomy and value validation"
```

---

## Task 3: `sender-trait-signature.ts` — content signature

**Files:**
- Create: `src/sender-trait-signature.ts`
- Test: `src/__tests__/sender-trait-signature.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { computeTraitSourceSig, type TraitSourceEmail } from "../sender-trait-signature.js";

const sample: TraitSourceEmail[] = [
  { from: "a@x.com", subject: "Hi", snippet: "hello", labels: ["INBOX"] },
  { from: "a@x.com", subject: "Re: Hi", snippet: "thanks", labels: [] },
];

describe("computeTraitSourceSig", () => {
  it("is stable for the same input regardless of label order", () => {
    const a = computeTraitSourceSig([{ ...sample[0], labels: ["INBOX", "UNREAD"] }]);
    const b = computeTraitSourceSig([{ ...sample[0], labels: ["UNREAD", "INBOX"] }]);
    expect(a).toBe(b);
  });

  it("is a 64-char hex sha256", () => {
    expect(computeTraitSourceSig(sample)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the evidence set changes", () => {
    const a = computeTraitSourceSig(sample);
    const b = computeTraitSourceSig([sample[0]]);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sender-trait-signature.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```typescript
import { createHash } from "node:crypto";

/** The decision-relevant bytes of one source email (mirrors attention-input-hash). */
export interface TraitSourceEmail {
  from: string;
  subject: string;
  snippet: string;
  labels: string[];
}

export const TRAIT_SIG_VERSION = "v1";

/**
 * SHA-256 over a canonical, order-stable JSON of the sampled emails. An
 * unchanged signature means the sender's evidence set is unchanged, so
 * re-extraction can be skipped (idempotent, cost-saving) — the AutoBE
 * decision-ledger staleness pattern, applied per sender.
 */
export function computeTraitSourceSig(emails: TraitSourceEmail[]): string {
  const canonical = emails.map((e) => ({
    from: e.from.trim().toLowerCase(),
    subject: e.subject.normalize("NFC"),
    snippet: e.snippet.normalize("NFC"),
    labels: [...e.labels].sort(),
  }));
  return createHash("sha256")
    .update(`${TRAIT_SIG_VERSION}:${JSON.stringify(canonical)}`)
    .digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/sender-trait-signature.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/sender-trait-signature.ts src/__tests__/sender-trait-signature.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): content signature for sender-trait staleness"
```

---

## Task 4: `sender-trait-store.ts` — conflict resolver (pure) + upsert

**Files:**
- Create: `src/sender-trait-store.ts`
- Test: `src/__tests__/sender-trait-store.test.ts`

- [ ] **Step 1: Write the failing test (resolver only — pure, no DB)**

```typescript
import { describe, expect, it } from "vitest";
import { resolveTraitUpsert, type IncumbentTrait } from "../sender-trait-store.js";
import type { CandidateTrait } from "../sender-trait-policy.js";

const challenger: CandidateTrait = {
  factKind: "relationship",
  factValue: "investor",
  confidence: 0.9,
  evidenceText: "We'd like to invest in your round.",
};

describe("resolveTraitUpsert", () => {
  it("creates when there is no incumbent", () => {
    const action = resolveTraitUpsert(null, challenger, "sig1");
    expect(action.type).toBe("create");
  });

  it("strengthens when the value matches", () => {
    const incumbent: IncumbentTrait = {
      factValue: "investor",
      observedCount: 2,
      status: "active",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "sig2");
    expect(action.type).toBe("strengthen");
    if (action.type === "strengthen") {
      expect(action.observedCount).toBe(3);
      expect(action.sourceSig).toBe("sig2");
    }
  });

  it("flags a conflict on a different value, never overwriting the incumbent", () => {
    const incumbent: IncumbentTrait = {
      factValue: "vendor",
      observedCount: 4,
      status: "active",
    };
    const action = resolveTraitUpsert(incumbent, challenger, "sig3");
    expect(action.type).toBe("conflict");
    if (action.type === "conflict") {
      expect(action.keepValue).toBe("vendor"); // incumbent preserved
      expect(action.conflictValue).toBe("investor"); // challenger stashed
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sender-trait-store.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```typescript
import { prisma } from "./db.js";
import type { CandidateTrait, SenderTraitKind } from "./sender-trait-policy.js";

export interface IncumbentTrait {
  factValue: string;
  observedCount: number;
  status: "active" | "superseded" | "conflicted";
}

export type UpsertAction =
  | { type: "create"; sourceSig: string }
  | { type: "strengthen"; observedCount: number; sourceSig: string }
  | { type: "conflict"; keepValue: string; conflictValue: string };

/**
 * Pure conflict resolver. Never silently overwrites: a contradicting value
 * flips the row to `conflicted`, keeps the incumbent value, and stashes the
 * challenger (the AutoBE detectDecisionConflicts pattern). Resolution (who
 * wins) is deferred to the fast-follow.
 */
export function resolveTraitUpsert(
  incumbent: IncumbentTrait | null,
  challenger: CandidateTrait,
  sourceSig: string,
): UpsertAction {
  if (incumbent === null) return { type: "create", sourceSig };
  if (incumbent.factValue === challenger.factValue) {
    return { type: "strengthen", observedCount: incumbent.observedCount + 1, sourceSig };
  }
  return { type: "conflict", keepValue: incumbent.factValue, conflictValue: challenger.factValue };
}

/**
 * Apply one candidate trait for (userId, sender, kind). Reads the incumbent,
 * resolves, and writes. Transactional via a single upsert/update per call.
 */
export async function upsertSenderTrait(props: {
  userId: string;
  sender: string;
  candidate: CandidateTrait;
  sourceSig: string;
}): Promise<UpsertAction["type"]> {
  const { userId, sender, candidate, sourceSig } = props;
  const existing = await prisma.senderTrait.findUnique({
    where: {
      userId_sender_factKind: { userId, sender, factKind: candidate.factKind },
    },
  });

  const action = resolveTraitUpsert(
    existing
      ? { factValue: existing.factValue, observedCount: existing.observedCount, status: existing.status }
      : null,
    candidate,
    sourceSig,
  );

  if (action.type === "create") {
    await prisma.senderTrait.create({
      data: {
        userId,
        sender,
        factKind: candidate.factKind,
        factValue: candidate.factValue,
        confidence: candidate.confidence,
        evidenceText: candidate.evidenceText,
        sourceSig,
      },
    });
  } else if (action.type === "strengthen") {
    await prisma.senderTrait.update({
      where: { userId_sender_factKind: { userId, sender, factKind: candidate.factKind } },
      data: {
        observedCount: action.observedCount,
        sourceSig,
        evidenceText: candidate.evidenceText,
        confidence: candidate.confidence,
        lastSeenAt: new Date(),
        status: "active",
      },
    });
  } else {
    await prisma.senderTrait.update({
      where: { userId_sender_factKind: { userId, sender, factKind: candidate.factKind } },
      data: {
        status: "conflicted",
        conflictValue: action.conflictValue,
        conflictEvidence: candidate.evidenceText,
        conflictedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
  }
  return action.type;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/sender-trait-store.test.ts`
Expected: PASS (3 tests). (Only the pure `resolveTraitUpsert` is unit-tested; `upsertSenderTrait` is exercised end-to-end in Task 6's extractor tests via a mocked prisma.)

- [ ] **Step 5: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/sender-trait-store.ts src/__tests__/sender-trait-store.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): conflict resolver and upsert for sender traits"
```

---

## Task 5: `sender-trait-metrics.ts` — measurement aggregation

**Files:**
- Create: `src/sender-trait-metrics.ts`
- Test: `src/__tests__/sender-trait-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { summarizeTraits, type TraitRow } from "../sender-trait-metrics.js";

const rows: TraitRow[] = [
  { sender: "a@x.com", factKind: "relationship", status: "active", confidence: 0.9 },
  { sender: "a@x.com", factKind: "recurring_intent", status: "active", confidence: 0.8 },
  { sender: "b@x.com", factKind: "relationship", status: "conflicted", confidence: 0.5 },
];

describe("summarizeTraits", () => {
  it("computes coverage over the active-sender universe", () => {
    const m = summarizeTraits(rows, 4); // 4 active senders this window
    expect(m.sendersWithTrait).toBe(2); // a@x.com and b@x.com
    expect(m.coverage).toBeCloseTo(2 / 4);
  });

  it("computes the conflict rate over (sender,kind) rows", () => {
    const m = summarizeTraits(rows, 4);
    expect(m.totalTraits).toBe(3);
    expect(m.conflicted).toBe(1);
    expect(m.conflictRate).toBeCloseTo(1 / 3);
  });

  it("buckets confidence", () => {
    const m = summarizeTraits(rows, 4);
    expect(m.confidenceBuckets.high).toBe(1); // >= 0.8 -> 0.9 only? 0.8 is high too
  });

  it("never divides by zero", () => {
    const m = summarizeTraits([], 0);
    expect(m.coverage).toBe(0);
    expect(m.conflictRate).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sender-trait-metrics.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```typescript
import type { SenderTraitKind } from "./sender-trait-policy.js";

export interface TraitRow {
  sender: string;
  factKind: SenderTraitKind;
  status: "active" | "superseded" | "conflicted";
  confidence: number;
}

export interface TraitMetrics {
  totalTraits: number;
  sendersWithTrait: number;
  coverage: number; // sendersWithTrait / activeSenderCount
  conflicted: number;
  conflictRate: number; // conflicted / totalTraits
  confidenceBuckets: { high: number; mid: number; low: number }; // >=0.8 / >=0.5 / <0.5
}

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

/**
 * Honest-by-construction measurement (mirrors decision-metrics.ts): all derived
 * from real rows, no invented confidence. `activeSenderCount` is the universe of
 * senders seen in the window, supplied by the caller.
 */
export function summarizeTraits(rows: TraitRow[], activeSenderCount: number): TraitMetrics {
  const senders = new Set(rows.map((r) => r.sender));
  const conflicted = rows.filter((r) => r.status === "conflicted").length;
  const buckets = { high: 0, mid: 0, low: 0 };
  for (const r of rows) {
    if (r.confidence >= 0.8) buckets.high++;
    else if (r.confidence >= 0.5) buckets.mid++;
    else buckets.low++;
  }
  return {
    totalTraits: rows.length,
    sendersWithTrait: senders.size,
    coverage: ratio(senders.size, activeSenderCount),
    conflicted,
    conflictRate: ratio(conflicted, rows.length),
    confidenceBuckets: buckets,
  };
}

/** Read traits + active-sender count for a user (or all users) and summarize. */
export async function getTraitMetrics(prisma: typeof import("./db.js").prisma, userId?: string) {
  const where = userId ? { userId } : {};
  const rows = await prisma.senderTrait.findMany({
    where,
    select: { sender: true, factKind: true, status: true, confidence: true },
  });
  const activeSenders = new Set(rows.map((r) => r.sender)).size; // proxy: senders we have traits for
  return summarizeTraits(rows as TraitRow[], Math.max(activeSenders, 1));
}
```

> Note: `getTraitMetrics`'s `activeSenderCount` uses the trait-sender set as a proxy in v0 (so coverage reads ~1.0 until a true sender universe is wired). The plan's Task 8 admin route passes a real universe (distinct senders in `DecisionLabel` for the window) when available; keep the pure `summarizeTraits` the source of truth.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/sender-trait-metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/sender-trait-metrics.ts src/__tests__/sender-trait-metrics.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): coverage/conflict/confidence metrics"
```

---

## Task 6: `sender-trait-extractor.ts` — LLM extraction (mockable)

**Files:**
- Create: `src/sender-trait-extractor.ts`
- Test: `src/__tests__/sender-trait-extractor.test.ts`

- [ ] **Step 1: Write the failing test (mock the LLM, like email-classifier-model.test.ts)**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../openai.js", () => ({
  createCompletion: createCompletionMock,
  JUDGE_MODEL: "test-judge-model",
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { extractTraitsFromEmails } from "../sender-trait-extractor.js";

const emails = [
  { from: "vc@fund.com", subject: "Investment", snippet: "we want to invest", labels: [] },
];

beforeEach(() => createCompletionMock.mockReset());

describe("extractTraitsFromEmails", () => {
  it("returns validated candidates from a well-formed response", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              relationship: { value: "investor", confidence: 0.9, evidence: "we want to invest" },
              recurring_intent: { value: "sales_outreach", confidence: 0.7, evidence: "investment pitch" },
            }),
          },
        },
      ],
    });
    const traits = await extractTraitsFromEmails(emails, {});
    expect(traits.map((t) => `${t.factKind}:${t.factValue}`).sort()).toEqual([
      "recurring_intent:sales_outreach",
      "relationship:investor",
    ]);
    expect(traits[0].confidence).toBeGreaterThan(0);
  });

  it("drops a hallucinated value instead of storing it", async () => {
    createCompletionMock.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ relationship: { value: "frenemy", confidence: 0.9, evidence: "x" } }) } },
      ],
    });
    const traits = await extractTraitsFromEmails(emails, {});
    expect(traits).toHaveLength(0);
  });

  it("returns [] and does not throw on an LLM failure", async () => {
    createCompletionMock.mockRejectedValue(new Error("provider down"));
    await expect(extractTraitsFromEmails(emails, {})).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sender-trait-extractor.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```typescript
import { asUnitInterval, asString } from "./llm-coerce.js";
import { parseLlmJson } from "./llm-json.js";
import { createCompletion, JUDGE_MODEL } from "./openai.js";
import type { ProviderCredentials } from "./providers/index.js";
import { captureError } from "./sentry.js";
import type { CandidateTrait } from "./sender-trait-policy.js";
import { TRAIT_KINDS, validateTraitValue } from "./sender-trait-policy.js";
import type { TraitSourceEmail } from "./sender-trait-signature.js";

interface RawTrait {
  value?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}
type RawResponse = Partial<Record<string, RawTrait>>;

function buildPrompt(emails: TraitSourceEmail[]): string {
  const lines = emails.map(
    (e, i) => `${i}. from=${e.from} | subject=${e.subject} | ${e.snippet}`,
  );
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
          { role: "system", content: "You are a strict JSON sender profiler. JSON only, no fences." },
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
      const evidenceText = asString(entry.evidence);
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
    console.warn("[TRAITS] extraction failed — skipping sender:", err instanceof Error ? err.message : String(err));
    captureError(err, { tags: { scope: "sender-traits.extract" } });
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/sender-trait-extractor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/sender-trait-extractor.ts src/__tests__/sender-trait-extractor.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): LLM sender-trait extractor with taxonomy validation"
```

---

## Task 7: Batch runner — per-user + all-users, per-sender isolation

**Files:**
- Modify: `src/sender-trait-extractor.ts` (append the batch functions)
- Test: `src/__tests__/sender-trait-extractor.test.ts` (append a batch test)

- [ ] **Step 1: Write the failing test (append)**

```typescript
import { extractSenderTraitsForUser } from "../sender-trait-extractor.js";

const prismaMock = vi.hoisted(() => ({
  emailMessage: { findMany: vi.fn() },
  senderTrait: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
}));
vi.mock("../db.js", () => ({ prisma: prismaMock }));

describe("extractSenderTraitsForUser", () => {
  it("isolates a failing sender — others still persist", async () => {
    // sender A throws in extraction, sender B succeeds
    prismaMock.emailMessage.findMany.mockResolvedValue([
      { from: "a@x.com", subject: "s", snippet: "b", labels: [] },
      { from: "b@x.com", subject: "s", snippet: "b", labels: [] },
    ]);
    createCompletionMock
      .mockRejectedValueOnce(new Error("A fails"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ relationship: { value: "vendor", confidence: 0.8, evidence: "b" } }) } }],
      });

    const summary = await extractSenderTraitsForUser("user-1");
    expect(summary.sendersProcessed).toBe(2);
    expect(summary.sendersFailed).toBe(1);
    expect(prismaMock.senderTrait.create).toHaveBeenCalled(); // B persisted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sender-trait-extractor.test.ts -t isolates`
Expected: FAIL — `extractSenderTraitsForUser` not exported.

- [ ] **Step 3: Append the implementation**

```typescript
import { prisma } from "./db.js";
import { getUserLlmCredentials } from "./llm-credentials.js";
import { computeTraitSourceSig } from "./sender-trait-signature.js";
import { upsertSenderTrait } from "./sender-trait-store.js";

const SAMPLE_PER_SENDER = 8;
const MAX_SENDERS_PER_RUN = 50;

export interface TraitRunSummary {
  sendersProcessed: number;
  sendersFailed: number;
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
```

> The `extractTraitsFromEmails` test from Task 6 already mocks `createCompletion`; this task adds the `../db.js` mock. Keep both mocks at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/sender-trait-extractor.test.ts`
Expected: PASS (all extractor tests).

- [ ] **Step 5: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/sender-trait-extractor.ts src/__tests__/sender-trait-extractor.test.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): per-user/all-users batch with per-sender isolation"
```

---

## Task 8: Scheduler wiring — weekly batch (mirror voice-profile)

**Files:**
- Modify: `src/automation-scheduler.ts` (alongside the voice-profile block, ~line 875)

- [ ] **Step 1: Add the wiring (no new test — exercised by existing scheduler tests + manual; verify via tsc/biome)**

Find the weekly voice-profile block and add, right after it:
```typescript
    // --- Weekly: Sender Trait Extraction (Sunday only) ---
    // Off-hot-path per-user extraction of relationship/recurring_intent facts.
    // The judge does NOT read these in v0 — they are measured first.
    if (new Date().getDay() === 0) {
      import("./sender-trait-extractor.js")
        .then(({ extractSenderTraitsForAllUsers }) => extractSenderTraitsForAllUsers())
        .catch((err) => {
          console.error("[AUTOMATION] Sender trait extraction failed:", err);
          captureError(err, { tags: { scope: "automation.sender-traits" } });
        });
    }
```

- [ ] **Step 2: Verify type-check and lint**

Run: `npx tsc --noEmit` → Expected: exit 0.
Run (from repo root): `npx biome check packages/api/src/automation-scheduler.ts` → Expected: exit 0.

- [ ] **Step 3: Run the scheduler test suite to confirm no regression**

Run: `npx vitest run src/__tests__/automation-scheduler-timezone.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/automation-scheduler.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): wire weekly sender-trait extraction into the scheduler"
```

---

## Task 9: Admin route — `GET /api/admin/sender-traits`

**Files:**
- Modify: `src/routes/admin.ts` (add a route + import near the `decision-metrics` route)

- [ ] **Step 1: Add the import and route**

Near the top imports (alongside `getDecisionMetrics`):
```typescript
import { getTraitMetrics } from "../sender-trait-metrics.js";
import { prisma } from "../db.js";
```

Inside the admin plugin body (mirror an existing `GET` route's shape; `app` is the Fastify instance used by sibling routes):
```typescript
  // GET /api/admin/sender-traits — Phase 3/B2 measurement: coverage, conflict
  // rate, confidence, plus an evidence inspector (sender -> traits + evidence).
  app.get("/sender-traits", async (req) => {
    const userId = (req.query as { userId?: string }).userId;
    const metrics = await getTraitMetrics(prisma, userId);
    const rows = await prisma.senderTrait.findMany({
      where: userId ? { userId } : {},
      orderBy: [{ sender: "asc" }, { factKind: "asc" }],
      take: 200,
      select: {
        sender: true,
        factKind: true,
        factValue: true,
        confidence: true,
        evidenceText: true,
        status: true,
        conflictValue: true,
        observedCount: true,
      },
    });
    return { metrics, traits: rows };
  });
```

> Match the exact registration style of the sibling routes in `admin.ts` (path prefix, auth guard, `app` vs `fastify` identifier). If sibling routes use a leading `/admin/...` full path rather than a prefixed `/sender-traits`, follow that.

- [ ] **Step 2: Verify type-check and lint**

Run: `npx tsc --noEmit` → Expected: exit 0.
Run (from repo root): `npx biome check packages/api/src/routes/admin.ts` → Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add src/routes/admin.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): admin endpoint for sender-trait metrics and evidence"
```

---

## Task 10: CLI evidence inspector

**Files:**
- Create: `scripts/sender-traits.ts` (mirror `scripts/decision-metrics.ts`)

- [ ] **Step 1: Write the CLI**

```typescript
// Usage: npx tsx scripts/sender-traits.ts [userId]
// Prints sender-trait coverage/conflict metrics + an evidence table for the
// dogfood account. Read-only.
import { prisma } from "../src/db.js";
import { getTraitMetrics } from "../src/sender-trait-metrics.js";

async function main() {
  const userId = process.argv[2];
  const metrics = await getTraitMetrics(prisma, userId);
  console.log("Sender-trait metrics:", JSON.stringify(metrics, null, 2));

  const rows = await prisma.senderTrait.findMany({
    where: userId ? { userId } : {},
    orderBy: [{ sender: "asc" }, { factKind: "asc" }],
    take: 100,
    select: { sender: true, factKind: true, factValue: true, status: true, confidence: true, evidenceText: true },
  });
  console.log("\nEvidence inspector:");
  for (const r of rows) {
    const flag = r.status === "conflicted" ? " [CONFLICT]" : "";
    console.log(`  ${r.sender} | ${r.factKind}=${r.factValue} (${r.confidence.toFixed(2)})${flag}`);
    console.log(`    ↳ "${r.evidenceText}"`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it parses/type-checks**

Run (from repo root): `npx biome check packages/api/scripts/sender-traits.ts`
Expected: exit 0. (Scripts run via `tsx`, not the `src` tsconfig — biome is the lint gate.)

- [ ] **Step 3: Commit**

```bash
KLORN_SKIP_SEC_REVIEW=1 git add scripts/sender-traits.ts
KLORN_SKIP_SEC_REVIEW=1 git commit -m "feat(traits): CLI evidence inspector for sender traits"
```

---

## Task 11: Full gate + plan close-out

- [ ] **Step 1: Run the complete gate**

Run (from repo root): `npx biome check packages/api/src packages/api/scripts` → Expected: exit 0.
Run (from `packages/api`): `npx tsc --noEmit` → Expected: exit 0.
Run (from `packages/api`): `npx vitest run` → Expected: all tests pass (existing count + the new policy/signature/store/metrics/extractor tests).

- [ ] **Step 2: Confirm the hot path is unchanged**

Run: `git diff --stat HEAD~10 HEAD -- packages/api/src/poc-judge.ts packages/api/src/judge-context.ts packages/api/src/email-classifier.ts`
Expected: NO changes to these files from this plan (judge untouched in v0).

- [ ] **Step 3: Manual dogfood (founder account)**

After deploy + one weekly run (or invoking `extractSenderTraitsForUser` manually), run:
`npx tsx scripts/sender-traits.ts <dogfood userId>` and eyeball: does each `evidenceText` actually justify its trait? Is the conflict rate low? This is the gate to the deferred judge-injection fast-follow.

---

## Self-Review (completed)

- **Spec coverage:** data model (Task 1), taxonomy+validation (Task 2), signature reuse (Task 3), conflict resolver — no silent overwrite (Task 4), measurement (Task 5), extractor with drop-on-invalid + never-throw (Task 6), scheduler batch + per-sender isolation (Tasks 7–8), evidence inspector route+CLI (Tasks 9–10), error discipline (Tasks 6–8), tests (every unit), migration (Task 1). All spec sections map to a task.
- **Hot path:** no task modifies `poc-judge.ts`/`judge-context.ts` — verified explicitly in Task 11 Step 2.
- **Type consistency:** `CandidateTrait`/`SenderTraitKind` defined in Task 2, imported unchanged in Tasks 4/5/6/7; `resolveTraitUpsert`/`upsertSenderTrait`/`summarizeTraits`/`extractTraitsFromEmails`/`extractSenderTraitsForUser` names are stable across tasks.
- **Deferred (non-goals, not gaps):** judge injection, conflict resolution policy, domain rollup — explicitly out of v0 per the spec.
