import Link from "next/link";
import LandingRedirect from "../components/landing-redirect";

type IconName = "arrow" | "compass" | "graph" | "shield" | "thread";

const decisionCards = [
  {
    label: "신호",
    title: "투자자가 수정 지표를 요청했습니다",
    body: "메일, 내일 미팅, 아직 열린 자료 작업을 한 결정으로 묶습니다.",
    tone: "text-sky-200 border-sky-300/25 bg-sky-300/10",
  },
  {
    label: "맥락",
    title: "피치덱 수정이 아직 남아 있습니다",
    body: "답장하지 않은 메일과 미완료 작업이 같은 미팅 리스크를 가리킵니다.",
    tone: "text-amber-200 border-amber-300/25 bg-amber-300/10",
  },
  {
    label: "행동",
    title: "오후 3-4시를 비우고 답장 초안을 준비",
    body: "외부로 나가기 전 승인 가능한 다음 행동으로 정리합니다.",
    tone: "text-emerald-200 border-emerald-300/25 bg-emerald-300/10",
  },
];

const pillars = [
  {
    icon: "thread" as const,
    label: "수집",
    title: "업무 신호를 읽습니다",
    body: "메일, 일정, 작업, 기억을 오늘 봐야 할 한 화면으로 정리합니다.",
  },
  {
    icon: "graph" as const,
    label: "연결",
    title: "소음을 맥락으로 바꿉니다",
    body: "사람, 기한, 스레드, 약속을 영향을 주는 업무 기준으로 묶습니다.",
  },
  {
    icon: "shield" as const,
    label: "승인",
    title: "행동 전에 확인하게 합니다",
    body: "중요한 실행에는 근거, 리스크, 승인 경로가 함께 붙습니다.",
  },
];

const trustRows = [
  ["관찰", "업무 공간을 바꾸지 않고 중요한 패턴만 감지합니다."],
  ["정리", "중요한 신호를 짧은 결정 카드로 압축합니다."],
  ["초안", "답장, 리마인더, 일정 변경은 먼저 초안으로 둡니다."],
  ["승인", "외부 실행은 명확한 확인 뒤에만 진행합니다."],
];

function BrandMark({ className = "" }: { className?: string }) {
  return <img className={className} src="/brand/mark.svg?v=flow-5" alt="" />;
}

function HeroProductScene() {
  const rows = [
    ["답장", "OpenRouter Team", "모델 업데이트 메일 답장 필요", "2분"],
    ["보안", "Vercel Security", "배포 전 환경 변수 검토", "18분"],
    ["회의", "Mina Kim", "내일 파트너 콜 질문 준비", "1시간"],
  ];

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[#0f1115]" />
      <div className="absolute inset-y-0 right-0 hidden w-[64vw] min-w-[760px] lg:block">
        <div className="absolute right-[-70px] top-20 h-[548px] w-[890px] rotate-[-1deg] rounded-xl border border-stone-700/60 bg-[#151922] shadow-2xl shadow-black/45">
          <div className="flex h-12 items-center gap-2 border-b border-stone-800 px-4">
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="ml-4 text-xs font-medium text-stone-500">Jigeum / 오늘</span>
          </div>
          <div className="grid h-[496px] grid-cols-[210px_1fr]">
            <aside className="border-r border-stone-800 bg-[#111318] p-4">
              <div className="mb-8 flex items-center gap-3">
                <BrandMark className="h-8 w-8" />
                <div>
                  <p className="text-sm font-semibold text-stone-100">Jigeum</p>
                  <p className="text-[10px] text-stone-500">지금 중요한 것</p>
                </div>
              </div>
              {["결정 큐", "메일", "캘린더", "브리핑"].map((item, index) => (
                <div
                  key={item}
                  className={`mb-1 rounded-md px-3 py-2 text-sm ${
                    index === 0 ? "bg-stone-800 text-stone-100" : "text-stone-500"
                  }`}
                >
                  {item}
                </div>
              ))}
            </aside>
            <main className="p-6">
              <div className="mb-6 flex items-end justify-between gap-6">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                    결정 큐
                  </p>
                  <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                    오늘의 다음 행동
                  </h2>
                </div>
                <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-stone-800 bg-[#111318] text-center">
                  {["7", "3", "1"].map((value, index) => (
                    <div
                      key={value}
                      className="border-r border-stone-800 px-5 py-3 last:border-r-0"
                    >
                      <p className="text-lg font-semibold text-stone-100">{value}</p>
                      <p className="text-[10px] text-stone-500">
                        {["신호", "답장", "승인"][index]}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                {rows.map(([tag, sender, subject, time]) => (
                  <div
                    key={subject}
                    className="rounded-lg border border-stone-800 bg-[#111318] p-4"
                  >
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <span className="rounded border border-stone-700 px-2 py-1 text-[10px] text-stone-400">
                        {tag}
                      </span>
                      <span className="text-xs text-stone-600">{time}</span>
                    </div>
                    <p className="text-sm font-medium text-stone-100">{sender}</p>
                    <p className="mt-1 text-sm text-stone-500">{subject}</p>
                  </div>
                ))}
              </div>
            </main>
          </div>
        </div>
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#0f1115_0%,rgba(15,17,21,0.95)_40%,rgba(15,17,21,0.42)_74%,rgba(15,17,21,0.74)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-[#0f1115] to-transparent" />
    </div>
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

function MobilePreview() {
  return (
    <div className="mt-10 max-w-xl rounded-lg border border-white/10 bg-[#12161b]/90 p-4 shadow-2xl shadow-black/25 lg:hidden">
      <div className="mb-4 flex items-center justify-between border-b border-white/8 pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            결정 큐
          </p>
          <p className="mt-1 text-lg font-semibold text-white">주의가 필요한 항목 3개</p>
        </div>
        <span className="rounded border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-xs text-amber-200">
          실시간
        </span>
      </div>
      <div className="space-y-3">
        {["투자자에게 답장", "배포 위험 검토", "파트너 콜 준비"].map((item) => (
          <div key={item} className="rounded-md border border-white/8 bg-black/20 px-3 py-3">
            <p className="text-sm font-medium text-stone-100">{item}</p>
            <p className="mt-1 text-xs text-stone-500">근거 첨부됨 · 승인 준비</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#0f1115] text-[#f8f4ec]">
      <LandingRedirect />

      <section className="relative min-h-[88svh] overflow-hidden">
        <HeroProductScene />

        <nav className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 md:px-8">
          <Link href="/" className="flex items-center gap-3">
            <BrandMark className="h-9 w-9" />
            <span className="text-sm font-semibold tracking-[0.18em] text-stone-100">JIGEUM</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="whitespace-nowrap px-3 py-2 text-sm text-stone-300 transition hover:text-white"
            >
              로그인
            </Link>
            <Link
              href="/early-access"
              className="whitespace-nowrap rounded-md bg-[#f2eadc] px-4 py-2 text-sm font-semibold text-[#12100d] transition hover:bg-white"
            >
              얼리 액세스
            </Link>
          </div>
        </nav>

        <div className="relative z-20 mx-auto flex min-h-[calc(88svh-82px)] max-w-7xl flex-col justify-center px-5 pb-20 pt-12 md:px-8">
          <div className="max-w-3xl">
            <p className="mb-5 inline-flex items-center gap-2 border-b border-[#d8a45d]/50 pb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
              <Icon type="compass" className="h-4 w-4" />
              Decision queue
            </p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.04] tracking-tight text-white sm:text-5xl md:text-7xl md:leading-[0.98] lg:text-8xl">
              중요한 일만 남기고, 바로 판단하세요.
            </h1>
            <p className="mt-7 max-w-xl text-base leading-7 text-stone-300 md:text-xl md:leading-8">
              Jigeum은 메일, 일정, 작업의 신호를 한 큐로 정리하고 실행 전 필요한 근거를 보여줍니다.
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

          <MobilePreview />
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-10 px-5 py-20 md:grid-cols-[0.82fr_1.18fr] md:px-8 md:py-28">
        <div>
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
            결정 큐
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
            중요한 일은 카드 하나로 충분합니다.
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-7 text-stone-400 md:text-base">
            또 하나의 인박스가 아니라, 근거와 맥락이 붙은 결정 카드만 남깁니다.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#12161b] p-3 shadow-2xl shadow-black/30">
          <div className="rounded-md border border-white/8 bg-[#0d1014] p-4">
            <div className="mb-4 flex items-center justify-between gap-4 border-b border-white/8 pb-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-500">
                  결정 카드
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
                승인
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
                보류
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/8 bg-[#f3efe7] text-[#14110d]">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-20 md:grid-cols-3 md:px-8 md:py-24">
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

      <section className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
        <div className="grid gap-8 md:grid-cols-[0.8fr_1.2fr] md:items-start">
          <div>
            <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
              실행 원칙
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
              조용히 준비하고, 실행 전에는 분명하게.
            </h2>
          </div>
          <div className="grid overflow-hidden rounded-lg border border-white/10 md:grid-cols-4">
            {trustRows.map(([stage, body], index) => (
              <div
                key={stage}
                className="border-white/10 bg-white/[0.025] p-4 md:border-r md:last:border-r-0"
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#d8a45d]">
                  0{index + 1}
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
          결정이 필요한 일을 위해
        </p>
        <h2 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-6xl">
          다음 인박스는 결정 큐입니다.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-stone-400 md:text-base">
          하루가 복잡해지기 전에 맥락, 근거, 행동을 한 줄로 맞춥니다.
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
            <span>Jigeum은 흩어진 업무 신호를 믿고 실행할 결정으로 바꿉니다.</span>
          </div>
          <div className="flex gap-5">
            <Link href="/privacy" className="transition hover:text-stone-300">
              개인정보
            </Link>
            <Link href="/terms" className="transition hover:text-stone-300">
              약관
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
