"use client";

import Link from "next/link";
import type { ReactNode } from "react";

interface AuthScreenProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  asideTitle?: string;
  asideBody?: string;
  asideItems?: Array<{ label: string; value: string }>;
  footer?: ReactNode;
  navCtaHref?: string;
  navCtaLabel?: string;
}

export default function AuthScreen({
  eyebrow,
  title,
  description,
  children,
  asideTitle = "결정이 필요한 일만 남깁니다",
  asideBody = "Jigeum은 메일, 캘린더, 할 일 신호를 읽고 실행 전에 확인할 수 있는 카드로 바꿉니다.",
  asideItems = [
    { label: "신호", value: "메일과 캘린더의 의미 있는 변화를 감지" },
    { label: "맥락", value: "사람, 기한, 프로젝트를 연결" },
    { label: "승인", value: "외부 실행 전 근거 검토" },
  ],
  footer,
  navCtaHref = "/early-access",
  navCtaLabel = "얼리 액세스",
}: AuthScreenProps) {
  return (
    <main className="min-h-screen overflow-hidden bg-[#0f1115] text-stone-50">
      <nav className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <img src="/brand/mark.svg?v=flow-5" alt="" className="h-8 w-8" />
          <span className="text-sm font-semibold tracking-[0.14em] text-stone-100">Jigeum</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <Link
            className="whitespace-nowrap text-stone-400 transition hover:text-stone-100"
            href="/"
          >
            홈
          </Link>
          <Link
            className="whitespace-nowrap rounded-md border border-stone-700 px-3 py-2 text-stone-300 transition hover:border-stone-500 hover:text-stone-100"
            href={navCtaHref}
          >
            {navCtaLabel}
          </Link>
        </div>
      </nav>

      <section className="relative z-10 mx-auto grid min-h-[calc(100svh-76px)] max-w-6xl items-center gap-8 px-5 pb-16 pt-6 sm:px-6 lg:grid-cols-[1fr_0.9fr]">
        <aside className="hidden lg:block">
          <div className="max-w-xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              결정 큐
            </p>
            <h2 className="mt-4 text-5xl font-semibold leading-[1.02] tracking-tight text-white">
              {asideTitle}
            </h2>
            <p className="mt-5 max-w-lg text-base leading-7 text-stone-400">{asideBody}</p>
          </div>
          <div className="mt-9 max-w-xl overflow-hidden rounded-lg border border-stone-800 bg-[#111318]">
            {asideItems.map((item, index) => (
              <div
                key={item.label}
                className="grid grid-cols-[72px_1fr] gap-4 border-b border-stone-800 px-4 py-4 last:border-b-0"
              >
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-stone-600">
                    0{index + 1}
                  </p>
                  <p className="mt-1 text-sm font-medium text-stone-200">{item.label}</p>
                </div>
                <p className="text-sm leading-6 text-stone-300">{item.value}</p>
              </div>
            ))}
          </div>
        </aside>

        <div className="mx-auto w-full max-w-md">
          <div className="mb-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-stone-400">{description}</p>
          </div>

          <div className="rounded-lg border border-stone-800 bg-[#111318] p-5 shadow-xl shadow-black/20">
            {children}
          </div>

          {footer && <div className="mt-5 text-center text-xs text-stone-500">{footer}</div>}
        </div>
      </section>
    </main>
  );
}
