"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";

type StepState = "done" | "active" | "pending" | "failed";

export default function BetaLearningCard() {
  const { googleConnected, initSync } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const connected = googleConnected === true;
  const syncDone = initSync.status === "done";
  const syncFailed = initSync.status === "failed";
  const syncSkipped = initSync.status === "skipped";
  const syncing = initSync.status === "syncing";

  const progress = !connected
    ? 18
    : syncDone
      ? 100
      : syncFailed || syncSkipped
        ? 48
        : syncing
          ? 72
          : 42;

  const steps: Array<{ label: string; detail: string; state: StepState }> = [
    {
      label: "Google 연결",
      detail: connected ? "Gmail과 Calendar를 볼 수 있어요." : "연결 후 분석이 시작돼요.",
      state: connected ? "done" : "active",
    },
    {
      label: "최근 메일 확인",
      detail: syncDone
        ? initSync.emails > 0
          ? `새 메일 ${initSync.emails}개를 반영했어요.`
          : "최근 메일 상태를 확인했어요."
        : syncing
          ? "답장 필요 신호를 찾는 중이에요."
          : "연결 후 자동으로 확인해요.",
      state: !connected ? "pending" : syncFailed ? "failed" : syncDone ? "done" : "active",
    },
    {
      label: "일정 확인",
      detail: syncDone
        ? initSync.calendar > 0
          ? `앞으로 30일 일정 ${initSync.calendar}개를 반영했어요.`
          : "앞으로 30일 일정이 비어 있거나 이미 최신이에요."
        : syncing
          ? "미팅과 준비 신호를 정리하는 중이에요."
          : "브리핑 전에 한 번 더 확인해요.",
      state: !connected ? "pending" : syncFailed ? "failed" : syncDone ? "done" : "pending",
    },
  ];

  useEffect(() => {
    setDismissed(localStorage.getItem("eve-beta-learning-card-dismissed") === "true");
  }, []);

  const dismiss = () => {
    localStorage.setItem("eve-beta-learning-card-dismissed", "true");
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <section className="mb-6 rounded-xl border border-cyan-900/50 bg-cyan-950/15 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
            Beta learning
          </p>
          <h2 className="mt-2 text-base font-semibold text-gray-100">
            EVE가 처음 2-3일 동안 메일과 일정 패턴을 학습합니다.
          </h2>
          <p className="mt-2 text-sm leading-6 text-gray-400">
            처음 브리핑은 다소 보수적일 수 있고, 사용할수록 Top 3가 더 정확해져요.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!connected && (
            <Link
              href="/settings"
              className="rounded-lg border border-cyan-500/50 px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-500/10"
            >
              연결
            </Link>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg border border-gray-700 px-2.5 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-gray-200"
            aria-label="Hide beta learning notice"
          >
            닫기
          </button>
        </div>
      </div>

      <div className="mt-4 h-1.5 rounded-full bg-gray-800">
        <div
          className="h-full rounded-full bg-cyan-400 transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <div
            key={step.label}
            className="rounded-lg border border-gray-800/80 bg-black/20 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${dotClass(step.state)}`} />
              <p className="text-xs font-medium text-gray-200">{step.label}</p>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-gray-500">{step.detail}</p>
          </div>
        ))}
      </div>

      {syncFailed && (
        <p className="mt-3 text-xs text-amber-300">
          초기 분석이 잠시 실패했어요. 새로고침하거나 잠시 후 다시 열면 다시 시도합니다.
        </p>
      )}
    </section>
  );
}

function dotClass(state: StepState): string {
  switch (state) {
    case "done":
      return "bg-emerald-400";
    case "active":
      return "bg-cyan-300";
    case "failed":
      return "bg-amber-300";
    case "pending":
      return "bg-gray-600";
  }
}
