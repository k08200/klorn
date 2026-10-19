"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

interface ProposalEvidence {
  metric: string;
  value: number;
  target: number;
  sampleSize: number;
  windowDays: number;
}

interface Proposal {
  id: string;
  knob: string;
  currentValue: number;
  proposedValue: number;
  direction: "RAISE" | "LOWER";
  evidence: ProposalEvidence;
  updatedAt: string;
}

interface Ontology {
  tiers: string[];
  relation: {
    thresholds: Record<string, unknown>;
    // What the classifier actually runs on right now (base + approved overrides);
    // `overriddenKnobs` names the diff. Identical to `thresholds` with no approvals.
    effective: Record<string, unknown>;
    overriddenKnobs: string[];
  };
  entity: {
    priorThresholds: Record<string, unknown>;
    shortCircuitTiers: Record<string, unknown>;
  };
  pattern: { keywordScores: Record<string, unknown> };
  dial: { escalationConfidenceFloor: number; escalationModel: string | null };
  proposals: Proposal[];
  applied: Proposal[];
}

export default function AdminOntologyPage() {
  return (
    <AuthGuard>
      <OntologyPageInner />
    </AuthGuard>
  );
}

function OntologyPageInner() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [data, setData] = useState<Ontology | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch<Ontology>("/api/admin/ontology"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load the ontology.", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const recompute = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/admin/ontology/proposals/recompute", {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast("Proposals recomputed.", "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Recompute failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: "approve" | "dismiss" | "revert", done: string) => {
    setBusy(true);
    try {
      const res = await apiFetch<{ cacheRefreshed?: boolean } | null>(
        `/api/admin/ontology/proposals/${id}/${action}`,
        { method: "POST" },
      );
      // approve/revert change the DB then refresh the live cache; if the cache
      // refresh failed the DB says applied but the classifier is NOT yet on the
      // new value — don't report a clean success.
      if (res?.cacheRefreshed === false) {
        toast(
          "Saved, but the live cache didn't refresh — effective after the next restart.",
          "error",
        );
      } else {
        toast(done, "success");
      }
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : `${action} failed.`, "error");
    } finally {
      setBusy(false);
    }
  };
  const approve = (id: string) => act(id, "approve", "Approved — now live.");
  const dismiss = (id: string) => act(id, "dismiss", "Dismissed.");
  const revert = (id: string) => act(id, "revert", "Reverted to base.");

  // The API enforces requireAdmin on every endpoint here, but gate the UI shell
  // too so a logged-in non-admin never sees the admin chrome (matches admin/page.tsx).
  if (user?.role !== "ADMIN") {
    return (
      <div className="flex h-full items-center justify-center text-ink-dim">
        Admin access required.
      </div>
    );
  }

  return (
    <div className="min-h-dvh px-4 pb-28 pt-6 text-ink sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
            The brain the firewall runs on
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-mid">
            The deterministic core — tier rule, sender priors, keyword patterns, model dial — read
            live, plus threshold proposals derived from your override signal. Proposals are advisory
            until you act:{" "}
            <span className="text-ink">
              Approve applies the change to the live classifier immediately
            </span>{" "}
            (no code change); Revert restores the git-default constant.
          </p>
        </header>

        {loading ? (
          <p className="text-sm text-ink-dim">Loading...</p>
        ) : !data ? (
          <p className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-6 text-sm text-ink-mid">
            No ontology data.
          </p>
        ) : (
          <>
            <Proposals
              proposals={data.proposals}
              busy={busy}
              onRecompute={recompute}
              onApprove={approve}
              onDismiss={dismiss}
            />

            {data.applied.length > 0 && (
              <Applied applied={data.applied} busy={busy} onRevert={revert} />
            )}

            <Section title="Tiers">
              <div className="flex flex-wrap gap-2">
                {data.tiers.map((t) => (
                  <span
                    key={t}
                    className="rounded-md border border-line bg-surface-hover px-2.5 py-1 text-sm font-semibold"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </Section>

            <Section title="Relation — tier thresholds">
              {data.relation.overriddenKnobs.length > 0 ? (
                <>
                  <h3 className="mb-1 text-xs uppercase tracking-wide text-ink-dim">
                    Effective (live){" "}
                    <span className="text-accent-deep">
                      · overridden: {data.relation.overriddenKnobs.join(", ")}
                    </span>
                  </h3>
                  <KeyVals record={data.relation.effective} />
                  <h3 className="mb-1 mt-3 text-xs uppercase tracking-wide text-ink-dim">
                    Git base
                  </h3>
                  <KeyVals record={data.relation.thresholds} />
                </>
              ) : (
                <KeyVals record={data.relation.thresholds} />
              )}
            </Section>

            <Section title="Entity — sender knowledge">
              <h3 className="mb-1 text-xs uppercase tracking-wide text-ink-dim">
                Prior thresholds
              </h3>
              <KeyVals record={data.entity.priorThresholds} />
              <h3 className="mb-1 mt-3 text-xs uppercase tracking-wide text-ink-dim">
                Short-circuit tiers
              </h3>
              <KeyVals record={data.entity.shortCircuitTiers} />
            </Section>

            <Section title="Pattern — keyword scores">
              <KeyVals record={data.pattern.keywordScores} />
            </Section>

            <Section title="Model dial">
              <KeyVals
                record={{
                  escalationConfidenceFloor: data.dial.escalationConfidenceFloor,
                  escalationModel:
                    data.dial.escalationModel ?? "off (JUDGE_ESCALATION_MODEL unset)",
                }}
              />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Proposals({
  proposals,
  busy,
  onRecompute,
  onApprove,
  onDismiss,
}: {
  proposals: Proposal[];
  busy: boolean;
  onRecompute: () => void;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <section className="panel-elevated mb-4 rounded-2xl border border-state-info-line bg-surface-panel p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-accent-deep">
          Proposals (advisory)
        </h2>
        <button
          type="button"
          onClick={onRecompute}
          disabled={busy}
          className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-sm text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-60"
        >
          Recompute
        </button>
      </div>
      {proposals.length === 0 ? (
        <p className="text-sm text-ink-mid">
          No open proposals — the override signal is within target.
        </p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {proposals.map((p) => (
            <li
              key={p.id}
              className="row-wash flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-ink">{p.knob}</span>
                  <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide text-accent-deep ring-1 ring-inset ring-accent/20">
                    {p.direction}
                  </span>
                  <span className="tabular-nums text-ink">
                    {p.currentValue} → {p.proposedValue}
                  </span>
                </div>
                <div className="mt-1 text-xs tabular-nums text-ink-dim">
                  {p.evidence.metric} = {p.evidence.value} (target {p.evidence.target}, n=
                  {p.evidence.sampleSize}, {p.evidence.windowDays}d)
                </div>
              </div>
              <div className="flex shrink-0 gap-2 self-start md:self-auto">
                <button
                  type="button"
                  onClick={() => onApprove(p.id)}
                  disabled={busy}
                  className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-accent-solid px-3.5 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:opacity-60"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(p.id)}
                  disabled={busy}
                  className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-sm text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-60"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Applied({
  applied,
  busy,
  onRevert,
}: {
  applied: Proposal[];
  busy: boolean;
  onRevert: (id: string) => void;
}) {
  return (
    <section className="panel-elevated mb-4 rounded-2xl border border-state-ok-line bg-surface-panel p-4 md:p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-state-ok-ink">
        Live overrides
      </h2>
      <p className="mb-3 text-xs text-ink-mid">
        Approved threshold changes the classifier is reading right now. Revert restores the git
        default.
      </p>
      <ul className="divide-y divide-line-soft">
        {applied.map((p) => (
          <li
            key={p.id}
            className="row-wash flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-ink">{p.knob}</span>
              <span className="tabular-nums text-ink">
                {p.currentValue} → {p.proposedValue}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onRevert(p.id)}
              disabled={busy}
              className="ease-strong inline-flex h-9 shrink-0 items-center self-start rounded-lg border border-line bg-surface-panel/70 px-3 text-sm text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97] disabled:opacity-60 md:self-auto"
            >
              Revert
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel-elevated mb-4 rounded-2xl border border-line/70 bg-surface-panel p-4 md:p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-accent-deep">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Render a flat or one-level-nested record as definition rows. */
function KeyVals({ record }: { record: Record<string, unknown> }) {
  return (
    <div className="divide-y divide-line-soft">
      {Object.entries(record).map(([key, val]) => (
        <div key={key} className="row-wash flex items-start justify-between gap-4 py-1.5 text-sm">
          <span className="text-ink-mid">{key}</span>
          {isRecord(val) ? (
            <div className="min-w-0 flex-1 pl-4">
              <KeyVals record={val} />
            </div>
          ) : (
            <span className="tabular-nums text-ink">
              {Array.isArray(val) ? val.join(", ") : String(val)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
