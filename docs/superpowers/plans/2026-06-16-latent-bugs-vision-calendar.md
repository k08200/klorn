# Sub-project A — Latent Bugs (Vision Ledger + Calendar TZ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two confirmed latent bugs — vision LLM calls billed to the wrong cost bucket, and calendar events written with a naive timezone on first login — each behind a regression test.

**Architecture:** Bug 1 is a one-line default alignment in `createVisionCompletion`. Bug 2 extracts a tiny pure helper (`resolveEventInstant`) into the existing calendar-time module, unit-tests it, and wires `init-sync` to use it with the user's timezone — mirroring the scheduler. No scheduler change, no shared calendar-sync extraction (that is sub-project D).

**Tech Stack:** TypeScript, Vitest, Fastify, Prisma, googleapis.

**Spec:** `docs/superpowers/specs/2026-06-16-latent-bugs-vision-calendar-design.md`

---

## File Structure

- `packages/api/src/openai.ts` — modify the vision ledger default (line 422).
- `packages/api/src/__tests__/llm-usage-chokepoint.test.ts` — add a regression test in the existing `createVisionCompletion` describe block.
- `packages/api/src/google-calendar-time.ts` — add `resolveEventInstant` (pure, beside `parseGoogleDateTime`).
- `packages/api/src/__tests__/google-calendar-time.test.ts` — add unit tests for `resolveEventInstant`.
- `packages/api/src/routes/auth.ts` — wire `init-sync` (lines 1086–1141) to use `resolveEventInstant` + the user's timezone.

---

## Task 1: Bug 1 — bill vision calls to the background bucket

**Files:**
- Modify: `packages/api/src/openai.ts:422`
- Test: `packages/api/src/__tests__/llm-usage-chokepoint.test.ts` (existing `createVisionCompletion` describe block, ~line 154)

- [ ] **Step 1: Write the failing test**

In `packages/api/src/__tests__/llm-usage-chokepoint.test.ts`, inside the existing
`describe("createVisionCompletion — usage ledger threading", ...)` block (after the
existing `it(...)`), add:

```ts
  it("defaults the ledger source to background when no priority is given", async () => {
    chain.push(makeProvider("gemini", "gemini:env-vision", async () => COMPLETION));
    const { createVisionCompletion } = await import("../openai.js");

    await createVisionCompletion(PARAMS, { userId: "user-3" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ source: "background" });
  });
```

(The file already resets `recorded`/`chain` in its `beforeEach`; rely on that.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/llm-usage-chokepoint.test.ts -t "defaults the ledger source to background"`
Expected: FAIL — `recorded[0].source` is `"foreground"`, not `"background"`.

- [ ] **Step 3: Write minimal implementation**

In `packages/api/src/openai.ts`, change line 422 from:

```ts
        source: options.priority ?? "foreground",
```

to:

```ts
        source: options.priority ?? "background",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/llm-usage-chokepoint.test.ts`
Expected: PASS (all tests in the file, including the existing foreground/background chokepoint tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/openai.ts packages/api/src/__tests__/llm-usage-chokepoint.test.ts
git commit -m "fix: bill vision ledger to the background bucket (was foreground)

The per-user gate charges createVisionCompletion against the background
bucket, but the usage ledger recorded it as foreground when no explicit
priority was passed. Align the ledger default to background."
```

---

## Task 2: Bug 2 — parse calendar times with the user timezone in init-sync

**Files:**
- Modify: `packages/api/src/google-calendar-time.ts` (add `resolveEventInstant` after `parseGoogleDateTime`)
- Test: `packages/api/src/__tests__/google-calendar-time.test.ts`
- Modify: `packages/api/src/routes/auth.ts` (init-sync calendar block, lines 1086–1141)

- [ ] **Step 1: Write the failing helper test**

In `packages/api/src/__tests__/google-calendar-time.test.ts`, add a new describe block.
Import `resolveEventInstant` alongside the existing imports from `../google-calendar-time.js`,
and add:

```ts
describe("resolveEventInstant", () => {
  it("delegates to parseGoogleDateTime for timed events (honors event timezone)", () => {
    const part = { dateTime: "2026-06-20T09:00:00", timeZone: "America/New_York" };
    expect(resolveEventInstant(part, "UTC").getTime()).toBe(
      parseGoogleDateTime("2026-06-20T09:00:00", "America/New_York", "UTC").getTime(),
    );
  });

  it("parses all-day events (date only) as a naive Date", () => {
    expect(resolveEventInstant({ date: "2026-06-20" }, "UTC").getTime()).toBe(
      new Date("2026-06-20").getTime(),
    );
  });

  it("falls back to the user zone when the event has no timeZone", () => {
    const part = { dateTime: "2026-06-20T09:00:00", timeZone: null };
    expect(resolveEventInstant(part, "America/New_York").getTime()).toBe(
      parseGoogleDateTime("2026-06-20T09:00:00", null, "America/New_York").getTime(),
    );
  });
});
```

(Ensure `parseGoogleDateTime` and `resolveEventInstant` are both imported from
`../google-calendar-time.js` at the top of the test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/google-calendar-time.test.ts -t "resolveEventInstant"`
Expected: FAIL — `resolveEventInstant` is not exported / not a function.

- [ ] **Step 3: Implement the helper**

In `packages/api/src/google-calendar-time.ts`, after the `parseGoogleDateTime` function, add:

```ts
export interface GoogleEventTimePart {
  dateTime?: string | null;
  date?: string | null;
  timeZone?: string | null;
}

/**
 * Resolve a Google Calendar event start/end part into an absolute instant.
 * Timed events (`dateTime`) honor the event's timeZone, falling back to the
 * user's zone; all-day events (`date` only) are parsed as-is. Mirrors the
 * scheduler so init-sync and the 60-second tick produce identical instants.
 */
export function resolveEventInstant(part: GoogleEventTimePart, userZone: string): Date {
  const raw = part.dateTime || part.date || "";
  return part.dateTime
    ? parseGoogleDateTime(raw, part.timeZone ?? null, userZone)
    : new Date(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/google-calendar-time.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Wire init-sync to use the helper + user timezone**

In `packages/api/src/routes/auth.ts`:

First, add `resolveEventInstant` to the existing calendar-time import. Find:

```ts
import { localMinuteOfDay, normalizeTimeZone } from "../time-zone.js";
```

Leave that line unchanged (it already gives `normalizeTimeZone`), and add a new import line beneath the existing import group:

```ts
import { resolveEventInstant } from "../google-calendar-time.js";
```

Then, inside the `init-sync` calendar `try` block (around line 1087), after building the
`calendar` client and **before** the `for (const item of ...)` loop, fetch the timezone:

```ts
      const userRow = await prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      });
      const userTimezone = normalizeTimeZone(userRow?.timezone);
```

Next, replace the per-item time parsing. Find the existing block (lines ~1106–1108):

```ts
        const startTime = item.start?.dateTime || item.start?.date || "";
        const endTime = item.end?.dateTime || item.end?.date || "";
        if (!startTime || !endTime) continue;
```

Replace it with:

```ts
        const startRaw = item.start?.dateTime || item.start?.date || "";
        const endRaw = item.end?.dateTime || item.end?.date || "";
        if (!startRaw || !endRaw) continue;
        const startTime = resolveEventInstant(item.start ?? {}, userTimezone);
        const endTime = resolveEventInstant(item.end ?? {}, userTimezone);
```

Finally, in BOTH the `create:` and `update:` objects of the `prisma.calendarEvent.upsert`
call, change the two fields from:

```ts
            startTime: new Date(startTime),
            endTime: new Date(endTime),
```

to (they are now already `Date` instances):

```ts
            startTime,
            endTime,
```

Leave `allDay: !item.start?.dateTime` unchanged.

- [ ] **Step 6: Verify types and the full API test suite**

Run: `cd packages/api && npx tsc --noEmit`
Expected: exit 0 (no errors).

Run: `npx vitest run`
Expected: PASS (full suite; no regressions).

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/google-calendar-time.ts \
  packages/api/src/__tests__/google-calendar-time.test.ts \
  packages/api/src/routes/auth.ts
git commit -m "fix: parse calendar times with the user timezone in init-sync

init-sync wrote calendar events with a naive new Date(), disagreeing with
the timezone-aware scheduler by the user's UTC offset. Add a pure
resolveEventInstant helper (mirrors the scheduler) and wire init-sync to
use it with normalizeTimeZone(user.timezone)."
```

---

## Task 3: Finalize — verify, rebase onto main, open PR

**Files:** none (git + CI only)

- [ ] **Step 1: Full local CI (verification-before-completion)**

Run, from repo root, and confirm each exits clean before claiming done:

```bash
npx biome check --diagnostic-level=error packages/
(cd packages/api && npx tsc --noEmit)
(cd packages/core && npx tsc --noEmit)
(cd packages/api && npx vitest run)
pnpm -r build
```

Expected: lint clean, both typechecks exit 0, all vitest tests pass, build succeeds.

- [ ] **Step 2: Rebase onto main**

This branch (`fix/latent-bugs-vision-calendar`) was cut on top of in-flight work
(agent-guide + M3 refactor commits). Rebase the two fix commits onto `main` so the PR
diff contains only the bug fixes:

```bash
git rebase --onto main $(git merge-base HEAD main) fix/latent-bugs-vision-calendar
git log --oneline main..HEAD
```

Expected: `main..HEAD` shows ONLY the two `fix:` commits (vision, calendar). If the rebase
hits conflicts in `openai.ts` / `routes/auth.ts` / calendar-time (because a parallel branch
touched them), resolve by keeping both the upstream change and this fix, then re-run Step 1.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/latent-bugs-vision-calendar
```

Then open a PR to `main` titled `fix: two latent bugs (vision ledger bucket + calendar timezone)`.
Do NOT merge — hand back to the user. (Repo rule: the user opens/merges PRs; never force-push.)

---

## Notes

- **No placeholders intended.** Every code block is the literal change.
- **Out of scope (other sub-projects):** the no-op ternary at openai.ts:408–411 (B), the
  shared `calendar-sync.ts` extraction that dedupes init-sync vs scheduler (D), the success
  envelope unification (F).
- **Coordination:** B (type-debt) and D (email-sync split, "M3 step N/6") are in flight on a
  parallel branch but touch different files; Step 2's rebase isolates this PR regardless.
