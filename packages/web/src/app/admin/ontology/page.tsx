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
      <div className="flex h-full items-center justify-center text-stone-500">
        Admin access required.
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#10100d] px-4 pb-28 pt-6 text-stone-50 sm:px-6 md:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-5 shadow-sm shadow-black/20">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">
            Shared ontology
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-50">
            The brain the firewall runs on
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-400">
            The deterministic core — tier rule, sender priors, keyword patterns, model dial — read
            live, plus threshold proposals derived from your override signal. Proposals are advisory
            until you act:{" "}
            <span className="text-stone-200">
              Approve applies the change to the live classifier immediately
            </span>{" "}
            (no code change); Revert restores the git-default constant.
          </p>
        </header>

        {loading ? (
          <p className="text-sm text-stone-500">Loading...</p>
        ) : !data ? (
          <p className="rounded-xl border border-stone-700/45 bg-stone-950/35 p-6 text-sm text-stone-400">
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
                    className="rounded-md border border-stone-700/45 bg-stone-800/40 px-2.5 py-1 text-sm font-semibold"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </Section>

            <Section title="Relation — tier thresholds">
              {data.relation.overriddenKnobs.length > 0 ? (
                <>
                  <h3 className="mb-1 text-xs uppercase tracking-wide text-stone-500">
                    Effective (live){" "}
                    <span className="text-amber-300">
                      · overridden: {data.relation.overriddenKnobs.join(", ")}
                    </span>
                  </h3>
                  <KeyVals record={data.relation.effective} />
                  <h3 className="mb-1 mt-3 text-xs uppercase tracking-wide text-stone-500">
                    Git base
                  </h3>
                  <KeyVals record={data.relation.thresholds} />
                </>
              ) : (
                <KeyVals record={data.relation.thresholds} />
              )}
            </Section>

            <Section title="Entity — sender knowledge">
              <h3 className="mb-1 text-xs uppercase tracking-wide text-stone-500">
                Prior thresholds
              </h3>
              <KeyVals record={data.entity.priorThresholds} />
              <h3 className="mb-1 mt-3 text-xs uppercase tracking-wide text-stone-500">
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
    <section className="mb-4 rounded-2xl border border-amber-300/35 bg-amber-300/[0.06] p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-200">
          Proposals (advisory)
        </h2>
        <button
          type="button"
          onClick={onRecompute}
          disabled={busy}
          className="rounded-lg border border-amber-300/50 px-3 py-1.5 text-sm text-amber-100 transition hover:bg-amber-300/10 disabled:opacity-60"
        >
          Recompute
        </button>
      </div>
      {proposals.length === 0 ? (
        <p className="text-sm text-amber-100/70">
          No open proposals — the override signal is within target.
        </p>
      ) : (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li
              key={p.id}
              className="flex flex-col gap-2 rounded-xl border border-amber-300/25 bg-stone-950/30 p-3 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-stone-200">{p.knob}</span>
                  <span className="rounded bg-amber-300/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-200">
                    {p.direction}
                  </span>
                  <span className="font-variant-numeric tabular-nums text-stone-100">
                    {p.currentValue} → {p.proposedValue}
                  </span>
                </div>
                <div className="mt-1 text-xs text-stone-500">
                  {p.evidence.metric} = {p.evidence.value} (target {p.evidence.target}, n=
                  {p.evidence.sampleSize}, {p.evidence.windowDays}d)
                </div>
              </div>
              <div className="flex shrink-0 gap-2 self-start md:self-auto">
                <button
                  type="button"
                  onClick={() => onApprove(p.id)}
                  disabled={busy}
                  className="rounded-lg bg-amber-300 px-3 py-1.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:opacity-60"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(p.id)}
                  disabled={busy}
                  className="rounded-lg border border-stone-700 px-3 py-1.5 text-sm text-stone-300 transition hover:border-stone-500 disabled:opacity-60"
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
    <section className="mb-4 rounded-2xl border border-emerald-500/35 bg-emerald-500/[0.06] p-4 md:p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-emerald-200">
        Live overrides
      </h2>
      <p className="mb-3 text-xs text-emerald-100/70">
        Approved threshold changes the classifier is reading right now. Revert restores the git
        default.
      </p>
      <ul className="space-y-2">
        {applied.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-2 rounded-xl border border-emerald-500/25 bg-stone-950/30 p-3 md:flex-row md:items-center md:justify-between"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-stone-200">{p.knob}</span>
              <span className="font-variant-numeric tabular-nums text-stone-100">
                {p.currentValue} → {p.proposedValue}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onRevert(p.id)}
              disabled={busy}
              className="shrink-0 self-start rounded-lg border border-stone-700 px-3 py-1.5 text-sm text-stone-300 transition hover:border-stone-500 disabled:opacity-60 md:self-auto"
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
    <section className="mb-4 rounded-2xl border border-stone-700/45 bg-stone-950/35 p-4 md:p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-300">{title}</h2>
      {children}
    </section>
  );
}

/** Render a flat or one-level-nested record as definition rows. */
function KeyVals({ record }: { record: Record<string, unknown> }) {
  return (
    <div className="divide-y divide-stone-800/60">
      {Object.entries(record).map(([key, val]) => (
        <div key={key} className="flex items-start justify-between gap-4 py-1.5 text-sm">
          <span className="text-stone-400">{key}</span>
          {isRecord(val) ? (
            <div className="min-w-0 flex-1 pl-4">
              <KeyVals record={val} />
            </div>
          ) : (
            <span className="font-variant-numeric tabular-nums text-stone-100">
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
