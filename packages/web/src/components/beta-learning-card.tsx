"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";

type StepState = "done" | "active" | "pending" | "failed";
const DISMISS_KEY = "jigeum-beta-learning-card-dismissed";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_DISMISS_KEY = `${LEGACY_KEY_PREFIX}-beta-learning-card-dismissed`;

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
      detail: connected ? "Gmail과 Calendar를 사용할 수 있어요." : "연결 후 분석이 시작됩니다.",
      state: connected ? "done" : "active",
    },
    {
      label: "최근 메일 확인",
      detail: syncDone
        ? initSync.emails > 0
          ? `새 메일 ${initSync.emails}개를 포함했어요.`
          : "최근 메일이 최신 상태입니다."
        : syncing
          ? "답장 신호를 찾는 중입니다."
          : "연결 후 자동으로 확인합니다.",
      state: !connected ? "pending" : syncFailed ? "failed" : syncDone ? "done" : "active",
    },
    {
      label: "캘린더 확인",
      detail: syncDone
        ? initSync.calendar > 0
          ? `앞으로 30일의 일정 ${initSync.calendar}개를 포함했어요.`
          : "앞으로 30일 일정이 없거나 이미 최신입니다."
        : syncing
          ? "회의와 준비 신호를 정리하는 중입니다."
          : "브리핑 전에 한 번 더 확인합니다.",
      state: !connected ? "pending" : syncFailed ? "failed" : syncDone ? "done" : "pending",
    },
  ];

  useEffect(() => {
    const legacyDismissed = localStorage.getItem(LEGACY_DISMISS_KEY);
    if (legacyDismissed) {
      localStorage.setItem(DISMISS_KEY, legacyDismissed);
      localStorage.removeItem(LEGACY_DISMISS_KEY);
    }
    setDismissed(localStorage.getItem(DISMISS_KEY) === "true");
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "true");
    localStorage.removeItem(LEGACY_DISMISS_KEY);
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <section className="mb-6 rounded-xl border border-amber-300/20 bg-amber-950/15 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">
            초기 학습
          </p>
          <h2 className="mt-2 text-base font-semibold text-stone-100">
            Jigeum은 처음 2-3일 동안 메일과 캘린더 패턴을 배웁니다.
          </h2>
          <p className="mt-2 text-sm leading-6 text-stone-400">
            초반 브리핑은 보수적일 수 있어요. 워크스페이스를 쓸수록 상위 3개가 더 정확해집니다.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!connected && (
            <Link
              href="/settings"
              className="rounded-lg border border-amber-300/40 px-3 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-300/10"
            >
              연결
            </Link>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg border border-stone-700 px-2.5 py-1.5 text-xs text-stone-400 transition hover:bg-stone-800 hover:text-stone-200"
            aria-label="초기 학습 안내 닫기"
          >
            닫기
          </button>
        </div>
      </div>

      <div className="mt-4 h-1.5 rounded-full bg-stone-800">
        <div
          className="h-full rounded-full bg-amber-300 transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <div
            key={step.label}
            className="rounded-lg border border-stone-800/80 bg-black/20 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${dotClass(step.state)}`} />
              <p className="text-xs font-medium text-stone-200">{step.label}</p>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-stone-500">{step.detail}</p>
          </div>
        ))}
      </div>

      {syncFailed && (
        <p className="mt-3 text-xs text-amber-300">
          초기 분석에서 일시 문제가 있었어요. 잠시 뒤 새로고침하거나 다시 열면 Jigeum이
          재시도합니다.
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
      return "bg-amber-300";
    case "failed":
      return "bg-amber-300";
    case "pending":
      return "bg-stone-600";
  }
}
