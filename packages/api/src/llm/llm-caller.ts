/**
 * Which app module made an LLM call — the "feature" column of the usage
 * ledger (LlmUsageLog.feature).
 *
 * Read from the call stack at the entry of createCompletion /
 * createVisionCompletion instead of asking every call site to pass a label:
 * there are dozens of call sites, a label is easy to forget, and an unlabeled
 * call is exactly the spend nobody can explain later. The first frame outside
 * the LLM and billing plumbing names the feature, as a module path relative to
 * the API source root ("mail/email-summarize", "judge/poc-judge"). A call site
 * can still pass an explicit `feature` when a module serves several features.
 *
 * Works for source paths (tests, tsx) and compiled paths (dist, production).
 */

/** Module prefixes that relay a call rather than originate it. */
const PLUMBING_PREFIXES = ["llm/", "billing/", "providers/"];

/** Path markers of the API source and build roots, most specific first. */
const ROOT_MARKERS = ["/packages/api/src/", "/packages/api/dist/"];

/** Enough frames to get past the plumbing even through a few wrappers. */
const STACK_DEPTH = 30;

const FRAME_PATH =
  /(?:\(|\bat\s(?:async\s)?)(?:file:\/\/)?(\/[^():]+?\.(?:ts|js|mts|mjs|cts|cjs)):\d+:\d+\)?\s*$/;

function moduleOf(frame: string): string | null {
  const match = FRAME_PATH.exec(frame);
  if (!match) return null;
  const path = match[1];
  if (path.includes("/node_modules/")) return null;
  for (const marker of ROOT_MARKERS) {
    const at = path.lastIndexOf(marker);
    if (at !== -1) return path.slice(at + marker.length).replace(/\.[^.]+$/, "");
  }
  return null;
}

/** The calling feature named by a stack string, or null if none is found. */
export function callerFeatureFromStack(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const frame of stack.split("\n").slice(1)) {
    const module = moduleOf(frame);
    if (!module) continue;
    if (PLUMBING_PREFIXES.some((prefix) => module.startsWith(prefix))) continue;
    return module;
  }
  return null;
}

/**
 * The app module that called into the LLM layer, read from the live stack.
 * Best-effort labelling: it returns null rather than throw, because it runs on
 * the path of every billable call and a label must never fail one.
 */
export function llmCallerFeature(): string | null {
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_DEPTH;
    const stack: unknown = new Error().stack;
    return typeof stack === "string" ? callerFeatureFromStack(stack) : null;
  } catch {
    return null;
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
}
