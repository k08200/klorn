/**
 * Run-over-run canary comparison (#769 — calibration-edge / margin-erosion).
 *
 * All existing tripwires are guaranteed-trip: an aggregate crosses a fixed
 * line, alarm fires. None notices a floor still cleared every run but by a
 * shrinking margin, or an item whose verdict flips while the aggregate stays
 * green. This module compares two `poc-accuracy.ts --out` reports of the
 * same eval set:
 *
 *  - FLIPS (the alarm): an item present in both runs whose predicted tier
 *    changed while its ground-truth label did not. On a fixed set with a
 *    temperature-0 judge, a flip means the decision boundary itself moved —
 *    prompt drift, provider-side model drift, or a threshold change.
 *  - MARGINS (the readout): per floor check, value − floor for both runs and
 *    the delta, so erosion is visible long before the floor trips.
 *
 * Pure — no I/O. The CLI (scripts/canary-compare.ts) owns files/exit codes.
 */

export interface CanaryFloorCheck {
  name: string;
  value: number;
  floor: number;
  gating: boolean;
}

export interface CanaryRow {
  id: string;
  truth: string;
  predicted: string;
  subject?: string;
  source?: string;
}

export interface CanaryRunReport {
  metadata: { floorChecks: CanaryFloorCheck[] };
  rows: CanaryRow[];
}

export interface VerdictFlip {
  id: string;
  subject?: string;
  truth: string;
  prevPredicted: string;
  currPredicted: string;
  prevSource?: string;
  currSource?: string;
}

export interface MarginDelta {
  name: string;
  gating: boolean;
  prevMargin: number;
  currMargin: number;
  /** currMargin − prevMargin; negative = the clearing margin shrank. */
  delta: number;
}

export interface CanaryComparison {
  flips: VerdictFlip[];
  marginDeltas: MarginDelta[];
  /** Items whose ground-truth label changed between runs — a set edit, not drift. */
  relabeledItems: string[];
  addedItems: string[];
  droppedItems: string[];
  /** Items present in both runs with an unchanged label (the flip population). */
  comparedCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an --out report at the boundary. Strict: a malformed baseline must
 * fail the canary loudly, never silently compare nothing and report "stable".
 */
export function parseCanaryRunReport(raw: unknown, label: string): CanaryRunReport {
  if (!isPlainObject(raw)) throw new Error(`canary report "${label}": not an object`);
  const metadata = raw.metadata;
  if (!isPlainObject(metadata) || !Array.isArray(metadata.floorChecks)) {
    throw new Error(`canary report "${label}": metadata.floorChecks must be an array`);
  }
  const floorChecks = metadata.floorChecks.map((check, i) => {
    if (
      !isPlainObject(check) ||
      typeof check.name !== "string" ||
      typeof check.value !== "number" ||
      typeof check.floor !== "number" ||
      typeof check.gating !== "boolean"
    ) {
      throw new Error(`canary report "${label}": floorChecks[${i}] needs name/value/floor/gating`);
    }
    return {
      name: check.name,
      value: check.value,
      floor: check.floor,
      gating: check.gating,
    };
  });
  if (!Array.isArray(raw.rows)) {
    throw new Error(`canary report "${label}": rows must be an array`);
  }
  const rows = raw.rows.map((row, i) => {
    if (
      !isPlainObject(row) ||
      typeof row.id !== "string" ||
      typeof row.truth !== "string" ||
      typeof row.predicted !== "string"
    ) {
      throw new Error(`canary report "${label}": rows[${i}] needs id/truth/predicted`);
    }
    return {
      id: row.id,
      truth: row.truth,
      predicted: row.predicted,
      subject: typeof row.subject === "string" ? row.subject : undefined,
      source: typeof row.source === "string" ? row.source : undefined,
    };
  });
  return { metadata: { floorChecks }, rows };
}

export function compareCanaryRuns(prev: CanaryRunReport, curr: CanaryRunReport): CanaryComparison {
  const prevById = new Map(prev.rows.map((r) => [r.id, r]));
  const currById = new Map(curr.rows.map((r) => [r.id, r]));

  const flips: VerdictFlip[] = [];
  const relabeledItems: string[] = [];
  let comparedCount = 0;

  for (const currRow of curr.rows) {
    const prevRow = prevById.get(currRow.id);
    if (!prevRow) continue;
    if (prevRow.truth !== currRow.truth) {
      relabeledItems.push(currRow.id);
      continue;
    }
    comparedCount++;
    if (prevRow.predicted !== currRow.predicted) {
      flips.push({
        id: currRow.id,
        subject: currRow.subject ?? prevRow.subject,
        truth: currRow.truth,
        prevPredicted: prevRow.predicted,
        currPredicted: currRow.predicted,
        prevSource: prevRow.source,
        currSource: currRow.source,
      });
    }
  }

  const prevChecks = new Map(prev.metadata.floorChecks.map((c) => [c.name, c]));
  const marginDeltas: MarginDelta[] = [];
  for (const currCheck of curr.metadata.floorChecks) {
    const prevCheck = prevChecks.get(currCheck.name);
    if (!prevCheck) continue;
    const prevMargin = prevCheck.value - prevCheck.floor;
    const currMargin = currCheck.value - currCheck.floor;
    marginDeltas.push({
      name: currCheck.name,
      gating: currCheck.gating,
      prevMargin,
      currMargin,
      delta: currMargin - prevMargin,
    });
  }

  return {
    flips,
    marginDeltas,
    relabeledItems,
    addedItems: curr.rows.filter((r) => !prevById.has(r.id)).map((r) => r.id),
    droppedItems: prev.rows.filter((r) => !currById.has(r.id)).map((r) => r.id),
    comparedCount,
  };
}
