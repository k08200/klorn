import Image from "next/image";
import Link from "next/link";
import LandingRedirect from "../components/landing-redirect";

type IconName = "arrow" | "compass" | "graph" | "shield" | "spark" | "thread";

const decisionCards = [
  {
    label: "Signal",
    title: "Investor asked for revised metrics",
    body: "Email arrived yesterday. Tomorrow's meeting is still on the calendar.",
    tone: "text-sky-200 border-sky-300/25 bg-sky-300/10",
  },
  {
    label: "Connection",
    title: "Pitch deck task is still in progress",
    body: "The unanswered email and the open task point to the same meeting risk.",
    tone: "text-amber-200 border-amber-300/25 bg-amber-300/10",
  },
  {
    label: "Move",
    title: "Block 3-4pm and draft the reply",
    body: "EVE prepares the work, then waits for your approval before acting.",
    tone: "text-emerald-200 border-emerald-300/25 bg-emerald-300/10",
  },
];

const pillars = [
  {
    icon: "thread" as const,
    label: "Signals",
    title: "Reads the work where it happens",
    body: "Email, calendar, tasks, reminders, and chat history become one operating picture.",
  },
  {
    icon: "graph" as const,
    label: "Context",
    title: "Groups noise into active work",
    body: "People, threads, deadlines, and promises are tied to the project they affect.",
  },
  {
    icon: "shield" as const,
    label: "Approval",
    title: "Acts with visible reasoning",
    body: "Every meaningful move shows the why chain before EVE asks to execute.",
  },
];

const trustRows = [
  ["Observe", "EVE watches patterns without changing anything."],
  ["Suggest", "Important connections become approval cards."],
  ["Draft", "Replies, reminders, and calendar moves are prepared first."],
  ["Approve", "External-facing work waits for your explicit yes."],
  ["Auto", "Low-risk actions run only inside learned policy."],
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
          alt="A quiet executive desk with a decision dashboard, notes, calendar, and morning light."
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,10,12,0.92)_0%,rgba(8,10,12,0.72)_40%,rgba(8,10,12,0.18)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,10,12,0.5)_0%,rgba(8,10,12,0.08)_42%,#0b0d10_100%)]" />

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
              Sign in
            </Link>
            <Link
              href="/early-access"
              className="rounded-md bg-[#f2eadc] px-4 py-2 text-sm font-semibold text-[#12100d] transition hover:bg-white"
            >
              Early access
            </Link>
          </div>
        </nav>

        <div className="relative z-10 mx-auto flex min-h-[calc(92svh-82px)] max-w-7xl flex-col justify-center px-5 pb-20 pt-12 md:px-8">
          <div className="max-w-3xl">
            <p className="mb-5 inline-flex items-center gap-2 border-b border-[#d8a45d]/50 pb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
              <Icon type="compass" className="h-4 w-4" />
              Decision OS for work
            </p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[0.98] tracking-tight text-white md:text-7xl lg:text-8xl">
              Stop checking apps. Clear decisions.
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-7 text-stone-300 md:text-xl md:leading-8">
              EVE reads the signals across email, calendar, tasks, and memory, then turns them into
              clear approval cards with the reasoning attached.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/early-access"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#d8a45d] px-6 text-sm font-semibold text-[#11100d] transition hover:bg-[#f0c982]"
              >
                Request early access
                <Icon type="arrow" className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center justify-center rounded-md border border-white/18 px-6 text-sm font-medium text-stone-200 transition hover:border-white/35 hover:bg-white/8"
              >
                Open command center
              </Link>
            </div>
          </div>

          <div className="mt-16 grid max-w-4xl grid-cols-1 border-y border-white/12 bg-black/18 backdrop-blur-sm md:grid-cols-3">
            {["Signals connected", "Approval first", "Memory learned"].map((label, index) => (
              <div key={label} className="border-white/12 px-5 py-4 md:border-r md:last:border-r-0">
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
            Live decision pattern
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
            One card. All the context.
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-7 text-stone-400 md:text-base">
            The product should not feel like another inbox. It should feel like a quiet operating
            room where every action has evidence, risk, and an approval path.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#12161b] p-3 shadow-2xl shadow-black/30">
          <div className="rounded-md border border-white/8 bg-[#0d1014] p-4">
            <div className="mb-4 flex items-center justify-between gap-4 border-b border-white/8 pb-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-500">
                  Decision Queue
                </p>
                <h3 className="mt-1 text-lg font-semibold text-white">Prepare investor follow-up</h3>
              </div>
              <span className="rounded border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                Approval needed
              </span>
            </div>

            <div className="grid gap-3">
              {decisionCards.map((card) => (
                <article key={card.label} className="rounded-md border border-white/8 bg-white/[0.025] p-4">
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
                Approve move
              </button>
              <button
                type="button"
                className="h-10 rounded-md border border-white/12 px-4 text-sm font-medium text-stone-300"
              >
                Edit first
              </button>
              <button
                type="button"
                className="h-10 rounded-md px-4 text-sm font-medium text-stone-500"
              >
                Dismiss
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
        <div className="rounded-lg border border-white/10 bg-[#11161c] p-4">
          <div className="relative min-h-[430px] overflow-hidden rounded-md border border-white/8 bg-[#0b0e12]">
            <div className="absolute left-[12%] top-[18%] h-28 w-28 rounded-full border border-sky-300/25 bg-sky-300/8" />
            <div className="absolute right-[14%] top-[16%] h-24 w-24 rounded-full border border-amber-300/25 bg-amber-300/8" />
            <div className="absolute bottom-[16%] left-[18%] h-24 w-24 rounded-full border border-emerald-300/25 bg-emerald-300/8" />
            <div className="absolute bottom-[20%] right-[18%] h-28 w-28 rounded-full border border-rose-300/25 bg-rose-300/8" />
            <div className="absolute left-1/2 top-1/2 flex h-32 w-32 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#d8a45d]/40 bg-[#d8a45d]/12 text-[#f4d49d]">
              <BrandMark className="h-12 w-12" />
            </div>
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 430" fill="none">
              <path d="M158 112 C250 120 260 180 300 215" stroke="#d8a45d" strokeOpacity=".42" />
              <path d="M440 105 C360 132 340 177 300 215" stroke="#d8a45d" strokeOpacity=".42" />
              <path d="M172 326 C250 300 270 255 300 215" stroke="#d8a45d" strokeOpacity=".42" />
              <path d="M430 310 C365 292 334 256 300 215" stroke="#d8a45d" strokeOpacity=".42" />
            </svg>
            {[
              ["Email thread", "left-[8%] top-[12%]"],
              ["Calendar", "right-[10%] top-[12%]"],
              ["Promise", "bottom-[12%] left-[13%]"],
              ["Task risk", "bottom-[14%] right-[13%]"],
            ].map(([label, pos]) => (
              <div
                key={label}
                className={`absolute ${pos} rounded border border-white/10 bg-black/35 px-3 py-2 text-xs text-stone-300 backdrop-blur`}
              >
                {label}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col justify-center">
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[#d8a45d]">
            Work graph
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
            EVE should show the shape of the work.
          </h2>
          <p className="mt-5 text-sm leading-7 text-stone-400 md:text-base">
            The strongest product surface is not chat. It is the map behind the queue: who is
            involved, what is blocked, which promises are open, and why this decision surfaced now.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-20 md:px-8 md:pb-28">
        <div className="border-y border-white/10 py-10">
          <div className="mb-8 flex items-center gap-3">
            <Icon type="shield" className="h-5 w-5 text-[#d8a45d]" />
            <h2 className="text-2xl font-semibold text-white">Trust is a ladder, not a toggle.</h2>
          </div>
          <div className="grid gap-0 overflow-hidden rounded-lg border border-white/10 md:grid-cols-5">
            {trustRows.map(([stage, body], index) => (
              <div key={stage} className="border-white/10 bg-white/[0.025] p-4 md:border-r md:last:border-r-0">
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
          Build the day from decisions
        </p>
        <h2 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-6xl">
          The next inbox is not an inbox.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-stone-400 md:text-base">
          It is a queue of reasoned moves, backed by the context that made them matter.
        </p>
        <Link
          href="/early-access"
          className="mt-9 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#f2eadc] px-6 text-sm font-semibold text-[#11100d] transition hover:bg-white"
        >
          Request early access
          <Icon type="arrow" className="h-4 w-4" />
        </Link>
      </section>

      <footer className="border-t border-white/8 px-5 py-8 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 text-sm text-stone-500 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-7 w-7" />
            <span>EVE turns scattered signals into approved decisions.</span>
          </div>
          <div className="flex gap-5">
            <Link href="/privacy" className="transition hover:text-stone-300">
              Privacy
            </Link>
            <Link href="/terms" className="transition hover:text-stone-300">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
