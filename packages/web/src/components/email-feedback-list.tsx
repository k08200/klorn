"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { RelativeTime } from "./relative-time";

type EmailPriority = "URGENT" | "NORMAL" | "LOW";

interface UserCorrectionFixture {
  id: string;
  capturedAt: string;
  from: string;
  subject: string;
  labels: string[];
  expectedSyncPriority: EmailPriority;
  capturedHeuristic: {
    priority: EmailPriority;
    reason: string | null;
    signals: string[];
  };
  note: string | null;
}

interface EmailFeedbackResponse {
  fixtures: UserCorrectionFixture[];
  count: number;
}

const PRIORITY_STYLES: Record<EmailPriority, string> = {
  URGENT: "bg-rose-500/10 text-rose-600 ring-rose-500/20",
  NORMAL: "bg-sky-500/10 text-sky-600 ring-sky-500/20",
  LOW: "bg-slate-100 text-slate-500 ring-slate-200",
};

function PriorityPill({ priority }: { priority: EmailPriority }) {
  const label = {
    URGENT: "Urgent",
    NORMAL: "Normal",
    LOW: "Low",
  }[priority];

  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ring-inset ${PRIORITY_STYLES[priority]}`}
    >
      {label}
    </span>
  );
}

export function EmailFeedbackList() {
  const [fixtures, setFixtures] = useState<UserCorrectionFixture[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<EmailFeedbackResponse>("/api/email/feedback?limit=50")
      .then((data) => {
        setFixtures(data.fixtures);
        setCount(data.count);
        setError(null);
      })
      .catch((err) => {
        captureClientError(err, { scope: "email-feedback.load" });
        setError("Could not load mail correction history.");
      })
      .finally(() => setLoading(false));
  }, []);

  const exportHref = useMemo(() => {
    if (fixtures.length === 0) return null;
    const blob = new Blob([JSON.stringify({ fixtures, count }, null, 2)], {
      type: "application/json",
    });
    return URL.createObjectURL(blob);
  }, [fixtures, count]);

  useEffect(() => {
    return () => {
      if (exportHref) URL.revokeObjectURL(exportHref);
    };
  }, [exportHref]);

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">
            {loading ? "Checking correction logs..." : `${count} correction records`}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            These corrections sharpen Klorn's mail judgment.
          </p>
        </div>
        {exportHref && (
          <a
            href={exportHref}
            download="klorn-email-feedback-fixtures.json"
            className="ease-strong inline-flex h-9 w-fit items-center rounded-lg border border-slate-200 bg-white/70 px-3 text-sm font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
          >
            Export JSON
          </a>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load correction logs.
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl border border-slate-200 bg-slate-50"
            />
          ))}
        </div>
      )}

      {!loading && !error && fixtures.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-10 text-center">
          <p className="text-sm font-medium text-slate-500">No corrected classifications yet.</p>
          <p className="mt-2 text-sm text-slate-400">
            When a mail classification is wrong, mark it from the mail view and it will appear here.
          </p>
        </div>
      )}

      {!loading && fixtures.length > 0 && (
        <div className="panel-elevated overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
          <div className="divide-y divide-slate-100">
            {fixtures.map((fixture) => (
              <div key={fixture.id} className="row-wash p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{fixture.subject}</p>
                    <p className="mt-1 truncate text-xs text-slate-400">{fixture.from}</p>
                  </div>
                  <RelativeTime
                    date={fixture.capturedAt}
                    className="shrink-0 text-xs text-slate-500"
                  />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <PriorityPill priority={fixture.capturedHeuristic.priority} />
                  <span className="text-xs text-slate-500">-&gt;</span>
                  <PriorityPill priority={fixture.expectedSyncPriority} />
                  {fixture.capturedHeuristic.reason && (
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-400">
                      {fixture.capturedHeuristic.reason}
                    </span>
                  )}
                </div>

                {fixture.capturedHeuristic.signals.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {fixture.capturedHeuristic.signals.slice(0, 6).map((signal) => (
                      <span
                        key={signal}
                        className="max-w-full truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-400"
                      >
                        {signal}
                      </span>
                    ))}
                  </div>
                )}

                {fixture.note && <p className="mt-3 text-xs text-slate-400">{fixture.note}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
