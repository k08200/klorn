"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../../components/auth-guard";
import ErrorAlert from "../../../../components/ui/error-alert";
import LoadingState from "../../../../components/ui/loading-state";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
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

/** `t` is passed in rather than called via useT() here — this is a plain
 * builder, not a component, so it cannot use hooks itself. */
function buildStatuses(
  t: (key: string) => string,
): Array<{ value: CandidateStatus; label: string }> {
  return [
    { value: "NEEDS_ANALYSIS", label: t("candidates.status.needsAnalysis") },
    { value: "NEEDS_INFO", label: t("candidates.status.needsInfo") },
    { value: "READY_TO_REVIEW", label: t("candidates.status.ready") },
    { value: "REVIEWING", label: t("candidates.status.reviewing") },
    { value: "CONTACTED", label: t("candidates.status.contacted") },
    { value: "SHORTLISTED", label: t("candidates.status.shortlisted") },
    { value: "REJECTED", label: t("candidates.status.rejected") },
    { value: "ARCHIVED", label: t("candidates.status.archived") },
  ];
}

export default function CandidateDetailPage() {
  return (
    <AuthGuard>
      <CandidateDetailView />
    </AuthGuard>
  );
}

function CandidateDetailView() {
  const { t } = useT();
  const STATUSES = buildStatuses(t);
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
      setError(t("candidates.detail.error.load"));
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
        setCommitmentToast(t("candidates.detail.commitmentOpened", { label }));
      } else {
        setCommitmentToast(null);
      }
    } catch (err) {
      captureClientError(err, { scope: "email.candidate-detail.update", emailId });
      setError(t("emailDetail.error.saveCandidateStatus"));
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
          className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97]"
        >
          {t("candidates.detail.queueLink")}
        </Link>
        {email && (
          <Link
            href={`/email/${email.id}`}
            className="ease-strong inline-flex h-9 items-center rounded-lg border border-line bg-surface-panel/70 px-3 text-xs font-medium text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97]"
          >
            {t("candidates.detail.sourceEmailLink")}
          </Link>
        )}
      </div>

      {loading && (
        <LoadingState rows={3} rowHeight="h-24" label={t("candidates.detail.loadingLabel")} />
      )}
      {error && !loading && <ErrorAlert onRetry={load}>{error}</ErrorAlert>}
      {commitmentToast && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-state-ok-line bg-state-ok-bg px-4 py-3 text-sm text-state-ok-ink"
        >
          {commitmentToast}
        </div>
      )}

      {email && profile && (
        <>
          <header className="mb-6 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
                {[profile.name || t("candidates.card.unknownName"), profile.role]
                  .filter(Boolean)
                  .join(" · ")}
              </h1>
              <p className="mt-2 text-sm text-ink-mid">
                {pipelineLabel(t, profile.pipelineStatus)}
                <span className="mx-1.5 text-slate-300">·</span>
                {t("candidates.confidence", {
                  percent: String(Math.round(profile.confidence * 100)),
                })}
                <span className="mx-1.5 text-slate-300">·</span>
                {t("emailDetail.attachment.fileCount", {
                  count: String(profile.evidenceFiles.length),
                })}
              </p>
            </div>
          </header>

          <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <section className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel p-5">
              <p className="text-sm leading-6 text-ink-muted">{profile.summary}</p>

              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                <Fact label={t("emailDetail.candidateCard.fact.contact")} value={profile.contact} />
                <Fact label={t("candidates.detail.fact.ageOrBirthYear")} value={profile.age} />
                <Fact label={t("emailDetail.candidateCard.fact.height")} value={profile.height} />
                <Fact
                  label={t("candidates.detail.fact.status")}
                  value={pipelineLabel(t, profile.pipelineStatus)}
                />
              </div>

              {profile.skills.length > 0 && (
                <ChipBlock title={t("candidates.detail.skillsTitle")} values={profile.skills} />
              )}
              {profile.links.length > 0 && (
                <ChipBlock title={t("candidates.detail.linksTitle")} values={profile.links} />
              )}

              {(profile.missingFields.length > 0 || profile.manualReviewFiles.length > 0) && (
                <div className="mt-5 rounded-xl border border-state-info-line bg-state-info-bg p-3">
                  <p className="text-xs font-medium text-state-info-ink">{profile.nextAction}</p>
                  {profile.manualReviewFiles.map((file) => (
                    <p key={file.filename} className="mt-1 text-[11px] text-accent-deeper/80">
                      {file.filename}: {file.reason}
                    </p>
                  ))}
                </div>
              )}

              <div className="mt-5 space-y-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                  {t("candidates.detail.evidenceFilesTitle")}
                </h2>
                {profile.evidenceFiles.map((file) => (
                  <div
                    key={file.filename}
                    className="rounded-lg border border-line-soft bg-surface-raised/70 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-ink">{file.filename}</span>
                      <span className="text-[10px] text-ink-mid">
                        {file.category || t("emailDetail.attachment.category.document")} ·{" "}
                        {file.analysisStatus}
                      </span>
                      {file.needsManualReview && (
                        <span className="shrink-0 rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-rose-600 ring-1 ring-inset ring-rose-500/20">
                          {t("candidates.attention.sourceCheck")}
                        </span>
                      )}
                    </div>
                    {file.summary && (
                      <p className="mt-1 text-[11px] leading-5 text-ink-dim">{file.summary}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <aside className="panel-elevated h-fit rounded-2xl border border-line/70 bg-surface-panel p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-mid">
                {t("candidates.detail.reviewStatusTitle")}
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
                          ? "border-accent-muted bg-accent/10 text-accent-deeper"
                          : "border-line bg-surface-panel/70 text-ink-mid hover:bg-surface-panel hover:text-ink"
                      }`}
                    >
                      {active && (
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-0 h-full w-[3px] bg-accent-light"
                        />
                      )}
                      {status.label}
                    </button>
                  );
                })}
              </div>
              <label className="mt-4 block">
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-ink-mid">
                  {t("candidates.detail.notesLabel")}
                </span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={6}
                  className="w-full rounded-lg border border-line bg-surface-panel/80 px-3 py-2 text-xs leading-5 text-ink-soft outline-none transition duration-150 ease-out focus:border-accent/50 focus:bg-surface-panel focus:ring-2 focus:ring-accent/15"
                />
              </label>
              <button
                type="button"
                onClick={() => update({ notes })}
                disabled={saving}
                className="glow-primary ease-strong mt-2 w-full rounded-lg bg-accent-solid px-3 py-2 text-xs font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? t("candidates.detail.saving") : t("candidates.detail.saveNotes")}
              </button>
              <div className="mt-4 rounded-lg border border-line-soft bg-surface-raised/70 px-3 py-2">
                <p className="text-xs text-ink-muted">{email.subject || t("common.untitled")}</p>
                <p className="mt-1 text-[11px] text-ink-dim">{email.from}</p>
              </div>
            </aside>
          </section>
        </>
      )}
      {email && !profile && !loading && (
        <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-6">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">
            {t("candidates.detail.noProfile.title")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-mid">
            {t("candidates.detail.noProfile.description")}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link
              href={`/email/${email.id}`}
              className="glow-primary ease-strong inline-flex min-h-11 items-center rounded-lg bg-accent-solid px-4 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97]"
            >
              {t("candidates.detail.noProfile.openSourceEmail")}
            </Link>
            <Link
              href="/email/candidates"
              className="ease-strong inline-flex min-h-11 items-center rounded-lg border border-line bg-surface-panel/70 px-4 text-sm text-ink-mid transition duration-150 hover:bg-surface-panel hover:text-ink active:scale-[0.97]"
            >
              {t("candidates.detail.noProfile.backToQueue")}
            </Link>
          </div>
          <div className="mt-5 rounded-lg border border-line-soft bg-surface-raised/70 px-3 py-2">
            <p className="text-xs text-ink-muted">{email.subject || t("common.untitled")}</p>
            <p className="mt-1 text-[11px] text-ink-dim">{email.from}</p>
          </div>
        </section>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface-raised/70 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-ink-dim">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-ink">{value || "-"}</p>
    </div>
  );
}

function ChipBlock({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="mt-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">{title}</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <span
            key={value}
            className="rounded-full border border-line bg-surface-raised px-2 py-1 text-xs text-ink-mid"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

/** `t` is passed in rather than called via useT() here — this is a plain
 * helper, not a component, so it cannot use hooks itself. */
function pipelineLabel(
  t: (key: string) => string,
  status: CandidateProfile["pipelineStatus"],
): string {
  if (status === "needs_analysis") return t("candidates.status.needsAnalysis");
  if (status === "needs_info") return t("candidates.status.needsInfo");
  return t("candidates.status.readyToReview");
}
