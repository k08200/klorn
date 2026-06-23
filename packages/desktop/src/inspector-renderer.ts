/**
 * Brain Inspector renderer (runs in the inspector window).
 *
 * Renders the shared ontology snapshot — the deterministic core the firewall
 * classifies on (tier rule, sender priors, keyword patterns, model dial) — into
 * a read-only panel. The snapshot arrives over IPC from the main process
 * (window.klornInspector.getOntology), already authenticated; this file only
 * shapes it into HTML. `renderOntology` is pure so it can be unit-tested without
 * Electron.
 */

declare global {
  interface Window {
    klornInspector?: {
      getOntology: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
    };
  }
}

/** Escape the five HTML-significant characters so snapshot values can't inject markup. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a flat or one-level-nested record as definition rows. */
function renderRecord(record: Record<string, unknown>): string {
  const rows = Object.entries(record).map(([key, val]) => {
    const rendered = isObject(val)
      ? `<div class="nested">${renderRecord(val)}</div>`
      : `<span class="val">${esc(Array.isArray(val) ? val.join(", ") : val)}</span>`;
    return `<div class="row"><span class="key">${esc(key)}</span>${rendered}</div>`;
  });
  return rows.join("");
}

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>${body}</section>`;
}

/** Render write-side proposals as "knob: current → proposed" rows with evidence. */
function renderProposals(proposals: readonly unknown[]): string {
  const rows = proposals.filter(isObject).map((p) => {
    const arrow = `${esc(p.currentValue)} → ${esc(p.proposedValue)}`;
    const ev = isObject(p.evidence)
      ? ` <span class="muted">(${esc(p.evidence.metric)}=${esc(p.evidence.value)})</span>`
      : "";
    return `<div class="row"><span class="key">${esc(p.knob)} <span class="dir">${esc(p.direction)}</span></span><span class="val">${arrow}${ev}</span></div>`;
  });
  return rows.join("");
}

/**
 * Build the inspector HTML body from an ontology snapshot. Defensive: the
 * snapshot is `unknown` (it crosses an IPC boundary), so each section degrades
 * to a placeholder rather than throwing when a field is missing or malformed.
 */
export function renderOntology(snapshot: unknown): string {
  if (!isObject(snapshot)) {
    return `<p class="empty">No ontology data.</p>`;
  }

  const parts: string[] = [];

  if (Array.isArray(snapshot.tiers)) {
    parts.push(
      section(
        "Tiers",
        `<div class="tiers">${snapshot.tiers.map((t) => `<span class="tier">${esc(t)}</span>`).join("")}</div>`,
      ),
    );
  }

  const relation = snapshot.relation;
  if (isObject(relation) && isObject(relation.thresholds)) {
    parts.push(section("Relation — tier thresholds", renderRecord(relation.thresholds)));
  }

  const entity = snapshot.entity;
  if (isObject(entity)) {
    const body: string[] = [];
    if (isObject(entity.priorThresholds)) {
      body.push(`<h3>Prior thresholds</h3>${renderRecord(entity.priorThresholds)}`);
    }
    if (isObject(entity.shortCircuitTiers)) {
      body.push(`<h3>Short-circuit tiers</h3>${renderRecord(entity.shortCircuitTiers)}`);
    }
    if (body.length > 0) parts.push(section("Entity — sender knowledge", body.join("")));
  }

  const pattern = snapshot.pattern;
  if (isObject(pattern) && isObject(pattern.keywordScores)) {
    parts.push(section("Pattern — keyword scores", renderRecord(pattern.keywordScores)));
  }

  const dial = snapshot.dial;
  if (isObject(dial)) {
    const model = dial.escalationModel;
    const dialBody = renderRecord({
      escalationConfidenceFloor: dial.escalationConfidenceFloor,
      escalationModel: model == null ? "off (JUDGE_ESCALATION_MODEL unset)" : model,
    });
    parts.push(section("Model dial", dialBody));
  }

  // Write-side: advisory threshold-change proposals from the override signal.
  // Read-only here — applied by a human via a code PR, never live.
  if (Array.isArray(snapshot.proposals) && snapshot.proposals.length > 0) {
    parts.push(section("Proposals (advisory)", renderProposals(snapshot.proposals)));
  }

  return parts.length > 0 ? parts.join("") : `<p class="empty">Ontology snapshot was empty.</p>`;
}

/** Fetch the snapshot over IPC and paint it (or an error) into #root. */
async function mount(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) return;
  const bridge = window.klornInspector;
  if (!bridge) {
    root.innerHTML = `<p class="error">Inspector bridge unavailable.</p>`;
    return;
  }
  root.innerHTML = `<p class="empty">Loading the brain…</p>`;
  try {
    const result = await bridge.getOntology();
    if (result.ok) {
      root.innerHTML = renderOntology(result.data);
    } else {
      root.innerHTML = `<p class="error">Could not load ontology: ${esc(result.error)}</p>`;
    }
  } catch (err) {
    root.innerHTML = `<p class="error">Could not load ontology: ${esc(
      err instanceof Error ? err.message : String(err),
    )}</p>`;
  }
}

// Only run in a real document (skipped under unit tests, which import the pure
// functions directly).
if (typeof document !== "undefined" && typeof window !== "undefined" && window.klornInspector) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void mount());
  } else {
    void mount();
  }
}
