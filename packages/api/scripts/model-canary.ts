/**
 * Model canary runner (#526) — behavioral probes for the non-judge models.
 *
 * Runs the fixed probe set (src/llm/model-canary-probes.ts) against each
 * surface's LIVE pinned model at temperature 0 and writes a report in the
 * exact shape scripts/canary-compare.ts consumes, so the weekly workflow
 * (model-canary.yml) reuses the judge canary's flip-alarm machinery verbatim:
 *
 *   rows[]                — { id: "<surface>:<probe>", truth: <expected|FINGERPRINT>,
 *                             predicted: <canonical answer>, subject: <prompt head> }
 *   metadata.floorChecks  — one report-only accuracy readout per surface
 *                           (objective probes only; fingerprints have no truth)
 *
 * Surfaces: chat (MODEL), agent (AGENT_MODEL), vision (VISION_MODEL — skipped
 * with a notice unless --vision, since it needs an image-capable provider).
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npx tsx scripts/model-canary.ts --out=./model-canary.json [--vision]
 *
 * Exit codes: 0 = report written; 1 = run error (a surface entirely failing
 * to answer is an error, not a silent empty report).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalizeProbeAnswer,
  FINGERPRINT_TRUTH,
  PROBE_SYSTEM_PROMPT,
  TEXT_PROBES,
  VISION_PROBES,
} from "../src/llm/model-canary-probes.js";
import { AGENT_MODEL, createCompletion, createVisionCompletion, MODEL } from "../src/llm/openai.js";

interface ProbeRow {
  id: string;
  truth: string;
  predicted: string;
  subject: string;
  source: string;
}

function parseArgs(argv: string[]): { out: string; vision: boolean } {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (const raw of argv) {
    const kv = raw.match(/^--([\w-]+)=(.+)$/);
    if (kv) {
      map.set(kv[1], kv[2]);
      continue;
    }
    const bare = raw.match(/^--([\w-]+)$/);
    if (bare) flags.add(bare[1]);
  }
  const out = map.get("out");
  if (!out) throw new Error("--out=<path> is required");
  return { out, vision: flags.has("vision") };
}

function contentOf(completion: { choices: Array<{ message?: { content?: string | null } }> }) {
  return completion.choices[0]?.message?.content ?? "";
}

async function runTextSurface(surface: string, model: string): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  for (const probe of TEXT_PROBES) {
    const completion = await createCompletion({
      model,
      temperature: 0,
      max_tokens: 24,
      messages: [
        { role: "system", content: PROBE_SYSTEM_PROMPT },
        { role: "user", content: probe.prompt },
      ],
    });
    rows.push({
      id: `${surface}:${probe.id}`,
      truth: probe.expect,
      predicted: canonicalizeProbeAnswer(contentOf(completion)),
      subject: probe.prompt.slice(0, 60),
      source: model,
    });
  }
  return rows;
}

async function runVisionSurface(): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  for (const probe of VISION_PROBES) {
    const image = readFileSync(resolve(probe.imagePath));
    const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
    const completion = await createVisionCompletion({
      // createVisionCompletion pins VISION_MODEL internally regardless of
      // params.model — params.model only feeds the cost gate, so mirror the
      // pin (same expression as llm/openai.ts) to bill the right SKU.
      model: process.env.VISION_MODEL || "google/gemini-2.5-flash:free",
      temperature: 0,
      max_tokens: 24,
      messages: [
        { role: "system", content: PROBE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: probe.prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    rows.push({
      id: `vision:${probe.id}`,
      truth: probe.expect,
      predicted: canonicalizeProbeAnswer(contentOf(completion)),
      subject: probe.prompt.slice(0, 60),
      source: process.env.VISION_MODEL || "google/gemini-2.5-flash:free",
    });
  }
  return rows;
}

/** Report-only accuracy over objective probes (fingerprints have no truth). */
function accuracyCheck(surface: string, rows: ProbeRow[]) {
  const objective = rows.filter((r) => r.truth !== FINGERPRINT_TRUTH);
  const correct = objective.filter((r) => r.truth === r.predicted).length;
  return {
    name: `${surface} objective probe accuracy`,
    value: objective.length === 0 ? 1 : correct / objective.length,
    floor: 0,
    pass: true,
    gating: false,
    detail: `${correct}/${objective.length} objective probes`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const surfaces: Array<{ surface: string; rows: ProbeRow[] }> = [];
  surfaces.push({ surface: "chat", rows: await runTextSurface("chat", MODEL) });
  // AGENT_MODEL defaults to MODEL; probe it anyway — the envs CAN diverge and
  // the comparison is per-row, so an identical pin just yields identical rows.
  surfaces.push({ surface: "agent", rows: await runTextSurface("agent", AGENT_MODEL) });
  if (args.vision) {
    surfaces.push({ surface: "vision", rows: await runVisionSurface() });
  } else {
    console.log("vision surface skipped (pass --vision to include it)");
  }

  const rows = surfaces.flatMap((s) => s.rows);
  const report = {
    metadata: {
      kind: "model-canary",
      probes: rows.length,
      floorChecks: surfaces.map((s) => accuracyCheck(s.surface, s.rows)),
    },
    rows,
  };

  for (const check of report.metadata.floorChecks) {
    console.log(`${check.name}: ${(check.value * 100).toFixed(0)}% (${check.detail})`);
  }
  for (const row of rows) {
    console.log(
      `  ${row.id} → ${row.predicted}${row.truth !== FINGERPRINT_TRUTH ? ` (expect ${row.truth})` : ""}`,
    );
  }

  const outPath = resolve(args.out);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nWrote model-canary report → ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
