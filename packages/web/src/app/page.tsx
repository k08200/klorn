import Image from "next/image";
import Link from "next/link";
import { EveSignalField } from "../components/brand-visuals";
import LandingRedirect from "../components/landing-redirect";

type IconName = "arrow" | "compass" | "graph" | "shield" | "spark" | "thread";

const decisionCards = [
  {
    label: "신호",
    title: "투자자가 수정 지표를 요청했습니다",
    body: "메일은 어제 도착했고, 내일 미팅은 아직 캘린더에 남아 있습니다.",
    tone: "text-sky-200 border-sky-300/25 bg-sky-300/10",
  },
  {
    label: "연결",
    title: "피치덱 작업이 아직 진행 중입니다",
    body: "답하지 않은 메일과 열린 작업이 같은 미팅 리스크를 가리킵니다.",
    tone: "text-amber-200 border-amber-300/25 bg-amber-300/10",
  },
  {
    label: "행동",
    title: "오후 3-4시를 비우고 답장 초안을 준비",
    body: "EVE가 일을 준비하고, 실행 전에는 승인을 기다립니다.",
    tone: "text-emerald-200 border-emerald-300/25 bg-emerald-300/10",
  },
];

const pillars = [
  {
    icon: "thread" as const,
    label: "신호",
    title: "일이 생기는 곳에서 읽습니다",
    body: "메일, 캘린더, 작업, 리마인더, 대화 기록을 하나의 운영 그림으로 묶습니다.",
  },
  {
    icon: "graph" as const,
    label: "맥락",
    title: "잡음을 진행 중인 일로 묶습니다",
    body: "사람, 스레드, 마감, 약속을 실제 영향을 받는 프로젝트에 연결합니다.",
  },
  {
    icon: "shield" as const,
    label: "승인",
    title: "보이는 근거로 움직입니다",
    body: "의미 있는 행동은 실행 요청 전에 왜 필요한지의 연결고리를 먼저 보여줍니다.",
  },
];

const trustRows = [
  ["관찰", "EVE는 아무것도 바꾸지 않고 패턴을 봅니다."],
  ["제안", "중요한 연결은 승인 카드가 됩니다."],
  ["초안", "답장, 리마인더, 일정 이동을 먼저 준비합니다."],
  ["승인", "외부로 나가는 일은 명시적인 승인을 기다립니다."],
  ["자동", "낮은 위험의 일만 학습된 정책 안에서 실행됩니다."],
];

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="40" height="40" rx="9" fill="#111827" />
      <path d="M20 6.5v27" stroke="#d8a45d" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M8 22.5c7.7-1.2 12.8-5.1 15.5-12.2 1.6 7.1 4.4 11.2 8.5 12.2-6.4.9-10.3 4.6-11.9 11.1-2.1-6.6-6.1-10.3-12.1-11.1Z"
        fill="#f3efe7"
      />
      <path
        d="M13.5 22.3c3.8-1.1 6.4-3.6 7.7-7.6 1 3.8 2.9 6.3 5.8 7.6-3.6 1-5.9 3.3-6.9 6.9-1.2-3.6-3.4-5.9-6.6-6.9Z"
        fill="#d8a45d"
      />
    </svg>
  );
}

function Icon({ type, className = "" }: { type: IconName; className?: string }) {
  const props = {
    className,
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (type) {
    case "arrow":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      );
    case "compass":
      return (
        <svg aria-hidden="true" {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="m15.5 8.5-2.2 5-4.8 2 2.2-5 4.8-2Z" />
        </svg>
      );
    case "graph":
      return (
        <svg aria-hidden="true" {...props}>
          <circle cx="6" cy="7" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="8" cy="18" r="2" />
          <circle cx="17" cy="17" r="2" />
          <path d="M8 7h8M7 9l1 7M10 17l5-1M17 9v6" />
        </svg>
      );
    case "shield":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M12 3 5 6v5c0 4.4 2.7 8 7 10 4.3-2 7-5.6 7-10V6l-7-3Z" />
          <path d="m8.8 12.2 2.1 2.1 4.5-5" />
        </svg>
      );
    case "spark":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
          <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8L18 16Z" />
        </svg>
      );
    case "thread":
      return (
        <svg aria-hidden="true" {...props}>
          <path d="M4 7c4 0 4 10 8 10s4-10 8-10" />
          <path d="M4 17c4 0 4-10 8-10s4 10 8 10" />
          <circle cx="4" cy="7" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="20" cy="17" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#0b0d10] text-[#f8f4ec]">
      <LandingRedirect />

      <section className="relative min-h-[92svh] overflow-hidden">
        <Image
          src="/scenes/hero-desk.png"
          alt="조용한 책상 위에 결정 대시보드, 노트, 캘린더가 놓인 장면"
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,10,12,0.92)_0%,rgba(8,10,12,0.72)_40%,rgba(8,10,12,0.18)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,10,12,0.5)_0%,rgba(8,10,12,0.08)_42%,#0b0d10_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.036)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.024)_1px,transparent_1px)] bg-[size:64px_64px] opacity-70" />

        <nav className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 md:px-8">
          <Link href="/" className="flex items-center gap-3">
            <BrandMark className="h-9 w-9" />
            <span className="text-sm font-semibold tracking-[0.18em] text-stone-100">EVE</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="px-3 py-2 text-sm text-stone-300 transition hover:text-white"
            >
              로그인
            </Link>
            <Link
              href="/early-access"
              className="rounded-md bg-[#f2eadc] px-4 py-2 text-sm font-semibold text-[#12100d] transition hover:bg-white"
            >
              얼리 액세스
            </Link>
          </div>
        </nav>

        <EveSignalField
          className="absolute bottom-20 right-8 z-10 hidden h-[420px] w-[38vw] max-w-xl rounded-lg opacity-90 backdrop-blur-md lg:block"
          tone="hero"
        />

        <div className="relative z-20 mx-auto flex min-h-[calc(92svh-82px)] max-w-7xl flex-col justify-center px-5 pb-20 pt-12 md:px-8">
          <div className="max-w-3xl">
            <p className="mb-5 inline-flex items-center gap-2 border-b border-[#d8a45d]/50 pb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
              <Icon type="compass" className="h-4 w-4" />
              업무를 위한 Decision OS
            </p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[0.98] tracking-tight text-white md:text-7xl lg:text-8xl">
              앱을 확인하지 말고, 결정을 정리하세요.
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-7 text-stone-300 md:text-xl md:leading-8">
              EVE는 메일, 캘린더, 작업, 메모리의 신호를 읽고 근거가 붙은 승인 카드로 바꿉니다.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/early-access"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#d8a45d] px-6 text-sm font-semibold text-[#11100d] transition hover:bg-[#f0c982]"
              >
                얼리 액세스 신청
                <Icon type="arrow" className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center justify-center rounded-md border border-white/[0.18] px-6 text-sm font-medium text-stone-200 transition hover:border-white/[0.35] hover:bg-white/[0.08]"
              >
                커맨드 센터 열기
              </Link>
            </div>
          </div>

          <div className="mt-16 grid max-w-4xl grid-cols-3 border-y border-white/12 bg-black/18 backdrop-blur-sm">
            {["신호 연결", "승인 우선", "메모리 학습"].map((label, index) => (
              <div key={label} className="border-white/12 px-4 py-4 md:border-r md:last:border-r-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-500">
                  0{index + 1}
                </p>
                <p className="mt-1 text-sm text-stone-200">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-10 px-5 py-20 md:grid-cols-[0.82fr_1.18fr] md:px-8 md:py-28">
        <div>
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
            실시간 결정 패턴
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
            하나의 카드. 모든 맥락.
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-7 text-stone-400 md:text-base">
            또 하나의 받은 편지함처럼 느껴지지 않아야 합니다. 모든 행동에 근거, 위험, 승인 경로가
            붙는 조용한 운영실이어야 합니다.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#12161b] p-3 shadow-2xl shadow-black/30">
          <div className="rounded-md border border-white/8 bg-[#0d1014] p-4">
            <div className="mb-4 flex items-center justify-between gap-4 border-b border-white/8 pb-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-500">
                  결정 큐
                </p>
                <h3 className="mt-1 text-lg font-semibold text-white">투자자 후속 대응 준비</h3>
              </div>
              <span className="rounded border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                승인 필요
              </span>
            </div>

            <div className="grid gap-3">
              {decisionCards.map((card) => (
                <article
                  key={card.label}
                  className="rounded-md border border-white/8 bg-white/[0.025] p-4"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${card.tone}`}
                    >
                      {card.label}
                    </span>
                    <div>
                      <h4 className="text-sm font-semibold text-stone-100">{card.title}</h4>
                      <p className="mt-1 text-sm leading-6 text-stone-400">{card.body}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-2 border-t border-white/8 pt-4 sm:flex-row">
              <button
                type="button"
                className="h-10 rounded-md bg-[#d8a45d] px-4 text-sm font-semibold text-[#11100d]"
              >
                행동 승인
              </button>
              <button
                type="button"
                className="h-10 rounded-md border border-white/12 px-4 text-sm font-medium text-stone-300"
              >
                먼저 수정
              </button>
              <button
                type="button"
                className="h-10 rounded-md px-4 text-sm font-medium text-stone-500"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/8 bg-[#f3efe7] text-[#14110d]">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-18 md:grid-cols-3 md:px-8 md:py-24">
          {pillars.map((pillar) => (
            <article key={pillar.label} className="border-t border-[#d7c9b6] pt-5">
              <div className="mb-8 flex h-10 w-10 items-center justify-center rounded-md bg-[#14110d] text-[#d8a45d]">
                <Icon type={pillar.icon} className="h-5 w-5" />
              </div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#8c6f43]">
                {pillar.label}
              </p>
              <h3 className="mt-3 text-2xl font-semibold tracking-tight">{pillar.title}</h3>
              <p className="mt-4 text-sm leading-7 text-[#5d5146]">{pillar.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-10 px-5 py-20 md:grid-cols-[1.1fr_0.9fr] md:px-8 md:py-28">
        <div className="rounded-lg border border-white/10 bg-[#11161c] p-4 shadow-2xl shadow-black/25">
          <div className="relative min-h-[430px] overflow-hidden rounded-md border border-white/8 bg-[#0b0e12]">
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:44px_44px]" />
            <div className="absolute left-1/2 top-1/2 flex h-32 w-32 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-[#d8a45d]/40 bg-[#d8a45d]/12 text-[#f4d49d] shadow-2xl shadow-amber-950/30">
              <BrandMark className="h-12 w-12" />
            </div>
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 430" fill="none">
              <path d="M172 112 C250 120 260 180 300 215" stroke="#d8a45d" strokeOpacity=".45" />
              <path d="M430 112 C360 132 340 177 300 215" stroke="#d8a45d" strokeOpacity=".45" />
              <path d="M172 318 C250 300 270 255 300 215" stroke="#d8a45d" strokeOpacity=".45" />
              <path d="M430 318 C365 292 334 256 300 215" stroke="#d8a45d" strokeOpacity=".45" />
            </svg>
            {[
              ["메일 스레드", "3개 신호", "left-[7%] top-[13%] border-sky-300/25"],
              ["캘린더", "2개 일정", "right-[8%] top-[13%] border-amber-300/25"],
              ["약속", "4개 열린 항목", "bottom-[13%] left-[11%] border-emerald-300/25"],
              ["작업 리스크", "승인 필요", "bottom-[13%] right-[9%] border-rose-300/25"],
            ].map(([label, meta, pos]) => (
              <div
                key={label}
                className={`absolute ${pos} min-w-[128px] rounded-md border bg-black/45 px-3 py-2 text-xs text-stone-300 shadow-xl shadow-black/20 backdrop-blur`}
              >
                <p className="font-medium text-stone-200">{label}</p>
                <p className="mt-1 text-[11px] text-stone-500">{meta}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col justify-center">
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
            업무 그래프
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
            EVE는 일의 모양을 보여줘야 합니다.
          </h2>
          <p className="mt-5 text-sm leading-7 text-stone-400 md:text-base">
            가장 강한 화면은 채팅이 아닙니다. 큐 뒤에 있는 지도입니다. 누가 관련되어 있고, 무엇이
            막혔고, 어떤 약속이 열려 있으며, 왜 지금 이 결정이 떠올랐는지를 보여줘야 합니다.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-20 md:px-8 md:pb-28">
        <div className="border-y border-white/10 py-10">
          <div className="mb-8 flex items-center gap-3">
            <Icon type="shield" className="h-5 w-5 text-[#d8a45d]" />
            <h2 className="text-2xl font-semibold text-white">
              신뢰는 토글이 아니라 사다리입니다.
            </h2>
          </div>
          <div className="grid gap-0 overflow-hidden rounded-lg border border-white/10 md:grid-cols-5">
            {trustRows.map(([stage, body], index) => (
              <div
                key={stage}
                className="border-white/10 bg-white/[0.025] p-4 md:border-r md:last:border-r-0"
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#d8a45d]">
                  L{index}
                </p>
                <h3 className="mt-3 text-base font-semibold text-stone-100">{stage}</h3>
                <p className="mt-3 text-xs leading-6 text-stone-500">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-5 pb-24 text-center md:px-8 md:pb-32">
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
          결정을 기준으로 하루를 세우세요
        </p>
        <h2 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-6xl">
          다음 받은 편지함은 받은 편지함이 아닙니다.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-stone-400 md:text-base">
          중요한 이유가 붙은 맥락 위에서, 근거 있는 행동이 줄지어 있는 큐입니다.
        </p>
        <Link
          href="/early-access"
          className="mt-9 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#f2eadc] px-6 text-sm font-semibold text-[#11100d] transition hover:bg-white"
        >
          얼리 액세스 신청
          <Icon type="arrow" className="h-4 w-4" />
        </Link>
      </section>

      <footer className="border-t border-white/8 px-5 py-8 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 text-sm text-stone-500 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-7 w-7" />
            <span>EVE는 흩어진 신호를 승인 가능한 결정으로 바꿉니다.</span>
          </div>
          <div className="flex gap-5">
            <Link href="/privacy" className="transition hover:text-stone-300">
              개인정보 처리방침
            </Link>
            <Link href="/terms" className="transition hover:text-stone-300">
              이용약관
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
