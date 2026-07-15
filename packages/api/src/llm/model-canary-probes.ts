/**
 * Model-canary probe set (#526) — behavioral fingerprints for the non-judge
 * models (MODEL / AGENT_MODEL / VISION_MODEL).
 *
 * The judge has ground-truth labels, so its canary (judge-canary.yml) scores
 * accuracy. These surfaces don't — so instead of the issue's original
 * embedding-drift proposal (whose own caveat list is a minefield:
 * nondeterminism, embedder drift reading as model drift, an empirical
 * threshold with no baselines to tune against), the canary reuses the
 * DETERMINISTIC flip mechanism proven by the judge canary (#769/#814):
 *
 *  - OBJECTIVE probes: micro-tasks with one canonical correct answer
 *    (arithmetic, extraction, date math, logic). A same-SKU model swap that
 *    breaks capability flips these AND shows up in the accuracy readout.
 *  - FINGERPRINT probes: tasks with many valid answers where a temperature-0
 *    model makes a stable idiosyncratic choice (pick a prime, complete a
 *    phrase). No objective truth — their entire value is that a DIFFERENT
 *    model almost certainly picks differently, so a metadata-invariant swap
 *    flips them even when it answers every objective probe correctly.
 *
 * Every probe demands a single-token answer at temperature 0, canonicalized
 * by canonicalizeProbeAnswer, so week-over-week comparison is exact-match.
 */

/** Truth marker for fingerprint probes — never counted in accuracy, only flips. */
export const FINGERPRINT_TRUTH = "FINGERPRINT";

export interface TextProbe {
  /** Stable id — the run-over-run join key. Never rename casually. */
  id: string;
  prompt: string;
  /** Canonical expected answer, or FINGERPRINT_TRUTH when any stable answer is fine. */
  expect: string;
}

export interface VisionProbe {
  id: string;
  prompt: string;
  /** Repo-relative path (from packages/api) of the committed image fixture. */
  imagePath: string;
  expect: string;
}

export const PROBE_SYSTEM_PROMPT =
  "You are a test probe. Answer with exactly one token (a single word, number, code, or date). No explanation, no punctuation beyond what the token itself requires.";

export const TEXT_PROBES: TextProbe[] = [
  // ── objective: capability micro-tasks ────────────────────────────────
  { id: "arith-chain", prompt: "Compute (17 * 6) - 14. Answer with one number.", expect: "88" },
  {
    id: "date-add",
    prompt: "What date is 10 days after 2026-07-15? Answer with one ISO date (YYYY-MM-DD).",
    expect: "2026-07-25",
  },
  {
    id: "marketing-pick",
    prompt:
      'Which email subject is marketing? A: "URGENT: production server down" B: "Last chance: 50% off everything". Answer with one letter.',
    expect: "B",
  },
  {
    id: "extract-invoice",
    prompt:
      'Extract the invoice number from: "Please pay invoice INV-2291 by Friday." Answer with one token.',
    expect: "INV-2291",
  },
  {
    id: "lang-id",
    prompt: 'What language is "좋은 아침입니다"? Answer with one ISO 639-1 code.',
    expect: "KO",
  },
  {
    id: "syllogism",
    prompt:
      "All klorns are birds. Some birds are blue. Are all klorns necessarily blue? Answer with one word: YES or NO.",
    expect: "NO",
  },
  {
    id: "negation-trap",
    prompt:
      '"The meeting is NOT cancelled." Is the meeting happening? Answer with one word: YES or NO.',
    expect: "YES",
  },
  {
    id: "alpha-first",
    prompt: "Which comes first alphabetically: mango, apple, plum? Answer with one word.",
    expect: "APPLE",
  },
  // ── fingerprint: stable idiosyncratic choices ────────────────────────
  {
    id: "fp-prime-pick",
    prompt: "Name any one prime number between 50 and 100. Answer with one number.",
    expect: FINGERPRINT_TRUTH,
  },
  {
    id: "fp-rps",
    prompt: "Choose one: rock, paper, or scissors. Answer with one word.",
    expect: FINGERPRINT_TRUTH,
  },
  {
    id: "fp-triage-word",
    prompt:
      "In one word, is email triage primarily about filtering or ranking? Answer with one word.",
    expect: FINGERPRINT_TRUTH,
  },
  {
    id: "fp-color-seven",
    prompt: "If the number 7 had a color, which one would it be? Answer with one color word.",
    expect: FINGERPRINT_TRUTH,
  },
];

export const VISION_PROBES: VisionProbe[] = [
  {
    id: "vision-solid-color",
    prompt: "What is the dominant color of this image? Answer with one word.",
    imagePath: "eval/fixtures/canary-solid-red.png",
    expect: "RED",
  },
  {
    id: "vision-fp-kind",
    prompt:
      "In one word: is this image a photograph, a gradient, or a solid? Answer with one word.",
    imagePath: "eval/fixtures/canary-solid-red.png",
    expect: FINGERPRINT_TRUTH,
  },
];

/**
 * Collapse formatting variance to one canonical token: strip wrapping
 * quotes/backticks, take the first whitespace-separated token, trim leading/
 * trailing punctuation (but keep internal '-' and '.' so dates and ids like
 * INV-2291 survive), uppercase. Empty → UNPARSEABLE (itself a stable,
 * comparable verdict — a model that stops following the format is drift too).
 */
export function canonicalizeProbeAnswer(raw: string): string {
  const stripped = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  const first = stripped.split(/\s+/)[0] ?? "";
  const token = first.replace(/^[^0-9A-Za-z가-힣]+|[^0-9A-Za-z가-힣]+$/g, "");
  if (token.length === 0) return "UNPARSEABLE";
  return token.toUpperCase();
}
