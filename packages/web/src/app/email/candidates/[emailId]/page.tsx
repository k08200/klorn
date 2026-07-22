"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../../components/auth-guard";
import ErrorAlert from "../../../../components/ui/error-alert";
import LoadingState from "../../../../components/ui/loading-state";
import { apiFetch } from "../../../../lib/api";
import { captureClientError } from "../../../../lib/sentry";

type CandidateStatus =
  | "NEEDS_ANALYSIS"
  | "NEEDS_INFO"
  | "READY_TO_REVIEW"
  | "REVIEWING"
  | "CONTACTED"
  | "SHORTLISTED"
  | "REJECTED"
  | "ARCHIVED";

interface CandidateProfile {
  pipelineStatus: "ready_to_review" | "needs_info" | "needs_analysis";
  nextAction: string;
  name: string | null;
  role: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  age: string | null;
  height: string | null;
  skills: string[];
  links: string[];
  summary: string;
  evidenceFiles: Array<{
    filename: string;
    category: string | null;
    summary: string | null;
    analysisStatus: string;
    needsManualReview: boolean;
    reviewReason: string | null;
  }>;
  manualReviewFiles: Array<{ filename: string; status: string; reason: string }>;
  missingFields: string[];
  confidence: number;
}

interface CandidateIntake {
  id: string;
  status: CandidateStatus;
  notes: string | null;
  updatedAt: string;
}

interface EmailDetail {
  id: string;
  from: string;
  subject: string;
  date: string;
  summary: string | null;
  candidateProfile: CandidateProfile | null;
  candidateIntake: CandidateIntake | null;
}

const STATUSES: Array<{ value: CandidateStatus; label: string }> = [
  { value: "NEEDS_ANALYSIS", label: "Needs analysis" },
  { value: "NEEDS_INFO", label: "Needs info" },
  { value: "READY_TO_REVIEW", label: "Ready" },
  { value: "REVIEWING", label: "Reviewing" },
  { value: "CONTACTED", label: "Contacted" },
  { value: "SHORTLISTED", label: "Shortlisted" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ARCHIVED", label: "Archived" },
];

export default function CandidateDetailPage() {
  return (
    <AuthGuard>
      <CandidateDetailView />
    </AuthGuard>
  );
}

function CandidateDetailView() {
  const params = useParams<{ emailId: string }>();
  const emailId = params?.emailId;
  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitmentToast, setCommitmentToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!emailId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<EmailDetail>(`/api/email/${emailId}`);
      setEmail(data);
      setNotes(data.candidateIntake?.notes ?? "");
    } catch (err) {
      captureClientError(err, { scope: "email.candidate-detail.load", emailId });
      setError("Could not load candidate details.");
    } finally {
      setLoading(false);
    }
  }, [emailId]);

  useEffect(() => {
    load();
  }, [load]);

  const update = async (patch: { status?: CandidateStatus; notes?: string | null }) => {
    if (!emailId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const data = await apiFetch<{
        candidateIntake: CandidateIntake;
        openedCommitmentId?: string | null;
      }>(`/api/email/${emailId}/candidate-intake`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setEmail((prev) => (prev ? { ...prev, candidateIntake: data.candidateIntake } : prev));
      if (data.openedCommitmentId && patch.status) {
        const label = STATUSES.find((s) => s.value === patch.status)?.label ?? patch.status;
        setCommitmentToast(`Commitment opened for "${label}" — see the ledger.`);
      } else {
        setCommitmentToast(null);
      }
    } catch (err) {
      captureClientError(err, { scope: "email.candidate-detail.update", emailId });
      setError("Could not save candidate status.");
    } finally {
      setSaving(false);
    }
  };

  const profile = email?.candidateProfile ?? null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <div className="mb-4 flex flex-wrap gap-2">
        <Link
          href="/email/candidates"
          className="ease-strong inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
        >
          Candidate queue
        </Link>
        {email && (
          <Link
            href={`/email/${email.id}`}
            className="ease-strong inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
          >
            Source email
          </Link>
        )}
      </div>

      {loading && <LoadingState rows={3} rowHeight="h-24" label="Loading candidate" />}
      {error && !loading && <ErrorAlert onRetry={load}>{error}</ErrorAlert>}
      {commitmentToast && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
        >
          {commitmentToast}
        </div>
      )}

      {email && profile && (
        <>
          <header className="mb-6 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-slate-900">
                {[profile.name || "Unknown name", profile.role].filter(Boolean).join(" · ")}
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                {pipelineLabel(profile.pipelineStatus)}
                <span className="mx-1.5 text-slate-300">·</span>
                Confidence {Math.round(profile.confidence * 100)}%
                <span className="mx-1.5 text-slate-300">·</span>
                {profile.evidenceFiles.length} files
              </p>
            </div>
          </header>

          <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <section className="panel-elevated overflow-hidden rounded-2xl border border-slate-200/70 bg-white p-5">
              <p className="text-sm leading-6 text-slate-600">{profile.summary}</p>

              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                <Fact label="Contact" value={profile.contact} />
                <Fact label="Age / birth year" value={profile.age} />
                <Fact label="Height" value={profile.height} />
                <Fact label="Status" value={pipelineLabel(profile.pipelineStatus)} />
              </div>

              {profile.skills.length > 0 && (
                <ChipBlock title="Skills / languages" values={profile.skills} />
              )}
              {profile.links.length > 0 && <ChipBlock title="Links" values={profile.links} />}

              {(profile.missingFields.length > 0 || profile.manualReviewFiles.length > 0) && (
                <div className="mt-5 rounded-xl border border-sky-200/70 bg-gradient-to-r from-sky-50 to-white p-3">
                  <p className="text-xs font-medium text-sky-800">{profile.nextAction}</p>
                  {profile.manualReviewFiles.map((file) => (
                    <p key={file.filename} className="mt-1 text-[11px] text-sky-700/80">
                      {file.filename}: {file.reason}
                    </p>
                  ))}
                </div>
              )}

              <div className="mt-5 space-y-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Evidence files
                </h2>
                {profile.evidenceFiles.map((file) => (
                  <div
                    key={file.filename}
                    className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-slate-900">{file.filename}</span>
                      <span className="text-[10px] text-slate-500">
                        {file.category || "document"} · {file.analysisStatus}
                      </span>
                      {file.needsManualReview && (
                        <span className="shrink-0 rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-rose-600 ring-1 ring-inset ring-rose-500/20">
                          Source check
                        </span>
                      )}
                    </div>
                    {file.summary && (
                      <p className="mt-1 text-[11px] leading-5 text-slate-400">{file.summary}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <aside className="panel-elevated h-fit rounded-2xl border border-slate-200/70 bg-white p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Review status
              </h2>
              <div className="mt-3 grid gap-2">
                {STATUSES.map((status) => {
                  const active = email.candidateIntake?.status === status.value;
                  return (
                    <button
                      key={status.value}
                      type="button"
                      onClick={() => update({ status: status.value, notes })}
                      disabled={saving}
                      className={`ease-strong relative overflow-hidden rounded-lg border px-3 py-2 text-left text-xs font-medium transition duration-150 active:scale-[0.98] disabled:opacity-50 ${
                        active
                          ? "border-sky-300 bg-accent/10 text-sky-700"
                          : "border-slate-200 bg-white/70 text-slate-500 hover:bg-white hover:text-slate-900"
                      }`}
                    >
                      {active && (
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-0 h-full w-[3px] bg-sky-400"
                        />
                      )}
                      {status.label}
                    </button>
                  );
                })}
              </div>
              <label className="mt-4 block">
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Notes
                </span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={6}
                  className="w-full rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-xs leading-5 text-slate-700 outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-white focus:ring-2 focus:ring-accent/15"
                />
              </label>
              <button
                type="button"
                onClick={() => update({ notes })}
                disabled={saving}
                className="glow-primary ease-strong mt-2 w-full rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3 py-2 text-xs font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save notes"}
              </button>
              <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
                <p className="text-xs text-slate-600">{email.subject || "Untitled"}</p>
                <p className="mt-1 text-[11px] text-slate-400">{email.from}</p>
              </div>
            </aside>
          </section>
        </>
      )}
      {email && !profile && !loading && (
        <section className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-6">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-slate-900">
            No candidate profile yet
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            Klorn found this message, but the attachments have not produced a structured profile.
            Open the source email, reanalyze attachments, or add notes while the review state is
            still clear.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link
              href={`/email/${email.id}`}
              className="glow-primary ease-strong inline-flex min-h-11 items-center rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-4 text-sm font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97]"
            >
              Open source email
            </Link>
            <Link
              href="/email/candidates"
              className="ease-strong inline-flex min-h-11 items-center rounded-lg border border-slate-200 bg-white/70 px-4 text-sm text-slate-500 transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
            >
              Back to queue
            </Link>
          </div>
          <div className="mt-5 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
            <p className="text-xs text-slate-600">{email.subject || "Untitled"}</p>
            <p className="mt-1 text-[11px] text-slate-400">{email.from}</p>
          </div>
        </section>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-slate-900">{value || "-"}</p>
    </div>
  );
}

function ChipBlock({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="mt-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <span
            key={value}
            className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function pipelineLabel(status: CandidateProfile["pipelineStatus"]): string {
  if (status === "needs_analysis") return "Needs analysis";
  if (status === "needs_info") return "Needs info";
  return "Ready to review";
}
