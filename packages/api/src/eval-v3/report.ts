/**
 * Aggregate benchmark cell files into the README tables. Runs are listed
 * individually ("55·54·56") because on 56 items one email is 1.8pt and a
 * mean hides the spread.
 */
import type { CounterfactualResult, UrgentCalibration } from "./calibration.js";
import type { Ratio, RunSummary } from "./metrics.js";

export interface BenchMeta {
  set: string;
  model: string;
  prompt: "v2" | "v3";
  run: number;
  ranAt: string;
  /** fixture (default) | empty | front. */
  context?: string;
  includeBody?: boolean;
  servedByOther?: number;
}

export interface BenchFile {
  meta: BenchMeta;
  summary: RunSummary;
  calibration?: UrgentCalibration;
  counterfactual?: CounterfactualResult[];
}

export interface Cell {
  set: string;
  model: string;
  prompt: "v2" | "v3";
  /** The prompt plus any non-default run condition, e.g. "v2 (front ctx)". */
  label: string;
  runs: BenchFile[];
}

/** Prompt plus run conditions: cells that differ in context or body never merge. */
export function cellLabel(meta: BenchMeta): string {
  const notes = [
    meta.context && meta.context !== "fixture" ? `${meta.context} ctx` : null,
    meta.includeBody === false ? "body off" : null,
  ].filter((n): n is string => n !== null);
  return notes.length > 0 ? `${meta.prompt} (${notes.join(", ")})` : meta.prompt;
}

export function groupCells(files: readonly BenchFile[]): Cell[] {
  const byKey = new Map<string, Cell>();
  for (const f of files) {
    const label = cellLabel(f.meta);
    const key = `${f.meta.set}|${f.meta.model}|${label}`;
    const cell = byKey.get(key) ?? {
      set: f.meta.set,
      model: f.meta.model,
      prompt: f.meta.prompt,
      label,
      runs: [],
    };
    byKey.set(key, { ...cell, runs: [...cell.runs, f].sort((a, b) => a.meta.run - b.meta.run) });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.set.localeCompare(b.set) ||
      a.model.localeCompare(b.model) ||
      a.label.localeCompare(b.label),
  );
}

/** "55·54·56 /56" when every run has the same support; otherwise each run as hit/n. */
export function fmtRuns(ratios: readonly Ratio[]): string {
  if (ratios.length === 0 || ratios.every((r) => r.n === 0)) return "—";
  const n = ratios[0].n;
  return ratios.every((r) => r.n === n)
    ? `${ratios.map((r) => r.hit).join("·")} /${n}`
    : ratios.map((r) => `${r.hit}/${r.n}`).join("·");
}

export const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const usd = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`);

function evidenceCell(c: Cell, s: readonly RunSummary[]): string {
  const ev = s.reduce((a, x) => ({ hit: a.hit + x.evidence.hit, n: a.n + x.evidence.n }), {
    hit: 0,
    n: 0,
  });
  return c.prompt === "v3" && ev.n > 0
    ? `${((ev.hit / ev.n) * 100).toFixed(1)}% (${ev.hit}/${ev.n})`
    : "—";
}

function mainRow(c: Cell): string {
  const s = c.runs.map((r) => r.summary);
  const cost = median(s.map((x) => x.costPer1kMailsUsd));
  const p50 = median(s.map((x) => x.p50Ms).filter((x): x is number => x !== null));
  return [
    c.set,
    `\`${c.model}\``,
    c.label,
    fmtRuns(s.map((x) => x.overall)),
    fmtRuns(s.map((x) => x.llmOverall)),
    fmtRuns(s.map((x) => x.pushRecall)),
    fmtRuns(s.map((x) => x.pushPrecision)),
    fmtRuns(s.map((x) => x.silentPrecision)),
    fmtRuns(s.map((x) => x.meetingRecall)),
    fmtRuns(s.map((x) => x.infoRecall)),
    s.map((x) => x.pushToSilent).join("·"),
    evidenceCell(c, s),
    c.prompt === "v3" ? s.map((x) => x.wouldEscalate).join("·") : "—",
    cost === null ? "—" : usd(cost),
    p50 === null ? "—" : String(Math.round(p50)),
  ].join(" | ");
}

export function mainTable(cells: readonly Cell[]): string {
  const head =
    "| set | model | prompt | overall | LLM-stage overall | PUSH recall | PUSH prec. | SILENT prec. | MEETING rec. | INFO rec. | PUSH→SILENT | evidence valid | would escalate | $/1k mails | p50 ms |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  return [head, ...cells.map((c) => `| ${mainRow(c)} |`)].join("\n");
}

function calibrationRow(c: Cell): string {
  const cal = c.runs.map((r) => r.calibration).filter((x): x is UrgentCalibration => Boolean(x));
  const cf = c.runs.map((r) => r.counterfactual ?? []);
  const confs = cal.flatMap((x) => x.confidences);
  const conf =
    confs.length > 0
      ? `${Math.min(...confs).toFixed(2)} / ${(median(confs) ?? 0).toFixed(2)} / ${Math.max(...confs).toFixed(2)}`
      : "—";
  const at = (i: number) => cf.map((v) => v[i]).filter(Boolean);
  const recallAt = [0, 1, 2]
    .map((i) => fmtRuns(at(i).map((v) => ({ hit: v.pushHit, n: v.pushTruth }))))
    .join(" → ");
  const falseAt = [0, 1, 2]
    .map((i) =>
      at(i)
        .map((v) => v.falsePush)
        .join("·"),
    )
    .join(" → ");
  const mismatches = at(0).reduce((sum, v) => sum + v.recomputeMismatches, 0);
  return [
    c.set,
    `\`${c.model}\``,
    c.label,
    cal.map((x) => `${x.viaLlm}/${x.urgentTotal}`).join("·"),
    conf,
    cal.map((x) => x.belowConfidenceBar).join("·"),
    cal.map((x) => `${x.missConfidenceGated}·${x.missUrgencyLow}·${x.missOther}`).join(" / "),
    recallAt,
    falseAt,
    String(mismatches),
  ].join(" | ");
}

export function calibrationTable(cells: readonly Cell[]): string {
  const head =
    "| set | model | prompt | urgent via LLM | confidence on urgent (min / median / max) | below 0.70 | misses: conf-gated · urgency-low · other | PUSH recall at conf ≥0.70 → ≥0.50 → ignored | false PUSH at same | re-run mismatches |\n" +
    "|---|---|---|---|---|---|---|---|---|---|";
  return [
    head,
    ...cells.filter((c) => c.prompt === "v2").map((c) => `| ${calibrationRow(c)} |`),
  ].join("\n");
}

export function spendLine(files: readonly BenchFile[]): string {
  const total = files.reduce((s, f) => s + f.summary.costUsd, 0);
  const calls = files.reduce((s, f) => s + f.summary.calls, 0);
  return `Total measured spend across ${files.length} run(s): ${usd(total)} over ${calls} successful LLM calls.`;
}
