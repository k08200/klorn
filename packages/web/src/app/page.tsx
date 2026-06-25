import Link from "next/link";
import LandingRedirect from "../components/landing-redirect";

type IconName =
  | "arrow"
  | "compass"
  | "graph"
  | "shield"
  | "thread"
  | "github"
  | "x"
  | "mail"
  | "slack";

const decisionCards = [
  {
    label: "Signal",
    title: "Investor asked for revised metrics",
    body: "Email, tomorrow's meeting, and open deck work are grouped into one decision.",
    tone: "text-sky-200 border-sky-300/25 bg-sky-300/10",
  },
  {
    label: "Context",
    title: "The pitch deck is still unfinished",
    body: "Unanswered mail and open tasks point to the same meeting risk.",
    tone: "text-amber-200 border-amber-300/25 bg-amber-300/10",
  },
  {
    label: "Action",
    title: "Hold 3-4 PM and prepare a reply draft",
    body: "The next move is staged for approval before anything leaves your workspace.",
    tone: "text-emerald-200 border-emerald-300/25 bg-emerald-300/10",
  },
];

const pillars = [
  {
    icon: "thread" as const,
    label: "Capture",
    title: "Read the work signals",
    body: "Mail, calendar, tasks, and memory are pulled into one view for today.",
  },
  {
    icon: "graph" as const,
    label: "Connect",
    title: "Turn noise into context",
    body: "People, deadlines, threads, and promises are linked by business impact.",
  },
  {
    icon: "shield" as const,
    label: "Approve",
    title: "Confirm before action",
    body: "Important execution carries evidence, risk, and an explicit approval path.",
  },
];

const trustRows = [
  ["Observe", "Detect important patterns without changing the workspace."],
  ["Condense", "Compress useful signals into short decision cards."],
  ["Draft", "Replies, reminders, and schedule changes start as drafts."],
  ["Approve", "External actions wait for a clear confirmation step."],
];

function BrandMark({ className = "" }: { className?: string }) {
  return <img className={className} src="/brand/mark.svg?v=matte1" alt="" />;
}

function HeroProductScene() {
  const rows = [
    ["Reply", "OpenRouter Team", "Model update email needs a response", "2m"],
    ["Security", "Vercel Security", "Review env vars before deploy", "18m"],
    ["Meeting", "Mina Kim", "Prep questions for partner call", "1h"],
  ];

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-surface-canvas" />
      <div className="absolute inset-y-0 right-0 hidden w-[66vw] min-w-[780px] lg:block">
        <div className="absolute right-[-42px] top-[72px] h-[548px] w-[900px] rotate-[-1deg] rounded-xl border border-stone-600/70 bg-surface-elevated shadow-2xl shadow-black/40">
          <div className="flex h-12 items-center gap-2 border-b border-stone-800 px-4">
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="ml-4 text-xs font-medium text-stone-500">Klorn / Today</span>
          </div>
          <div className="grid h-[496px] grid-cols-[210px_1fr]">
            <aside className="border-r border-stone-800 bg-surface-panel p-4">
              <div className="mb-8 flex items-center gap-3">
                <BrandMark className="h-8 w-8" />
                <div>
                  <p className="text-sm font-semibold text-stone-100">Klorn</p>
                  <p className="text-[10px] text-stone-500">The clear signal</p>
                </div>
              </div>
              {["Decision queue", "Mail", "Calendar", "Briefing"].map((item, index) => (
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
                    Decision queue
                  </p>
                  <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                    Today's next actions
                  </h2>
                </div>
                <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-stone-800 bg-surface-panel text-center">
                  {["7", "3", "1"].map((value, index) => (
                    <div
                      key={value}
                      className="border-r border-stone-800 px-5 py-3 last:border-r-0"
                    >
                      <p className="text-lg font-semibold text-stone-100">{value}</p>
                      <p className="text-[10px] text-stone-500">
                        {["Signals", "Replies", "Approvals"][index]}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                {rows.map(([tag, sender, subject, time]) => (
                  <div
                    key={subject}
                    className="rounded-lg border border-stone-800 bg-surface-panel p-4"
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
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#0f1115_0%,rgba(15,17,21,0.94)_39%,rgba(15,17,21,0.34)_74%,rgba(15,17,21,0.64)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-surface-canvas to-transparent" />
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
    case "github":
      return (
        <svg
          aria-hidden="true"
          className={className}
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.02 11.02 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
        </svg>
      );
    case "x":
      return (
        <svg
          aria-hidden="true"
          className={className}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
        </svg>
      );
    case "mail":
      return (
        <svg aria-hidden="true" {...props}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3.5 7 8.5 6 8.5-6" />
        </svg>
      );
    case "slack":
      return (
        <svg
          aria-hidden="true"
          className={className}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
        </svg>
      );
  }
}

function MobilePreview() {
  return (
    <div className="mt-10 max-w-xl rounded-lg border border-white/10 bg-surface-translucent/90 p-4 shadow-2xl shadow-black/25 lg:hidden">
      <div className="mb-4 flex items-center justify-between border-b border-white/8 pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Decision queue
          </p>
          <p className="mt-1 text-lg font-semibold text-white">3 items need attention</p>
        </div>
        <span className="rounded border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-xs text-amber-200">
          Live
        </span>
      </div>
      <div className="space-y-3">
        {["Reply to investor", "Review deploy risk", "Prep partner call"].map((item) => (
          <div key={item} className="rounded-md border border-white/8 bg-black/20 px-3 py-3">
            <p className="text-sm font-medium text-stone-100">{item}</p>
            <p className="mt-1 text-xs text-stone-500">Evidence attached · Ready for approval</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-surface-canvas text-brand-cream">
      <LandingRedirect />

      <section className="relative min-h-[84svh] overflow-hidden">
        <HeroProductScene />

        <nav className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 md:px-8">
          <Link href="/" className="flex items-center gap-3">
            <BrandMark className="h-9 w-9" />
            <span className="text-sm font-semibold tracking-[0.18em] text-stone-100">KLORN</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center whitespace-nowrap px-3 text-sm text-stone-300 transition hover:text-white"
            >
              Log in
            </Link>
            <Link
              href="/early-access"
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-md bg-brand-cream-soft px-4 text-sm font-semibold text-brand-ink-soft transition hover:bg-white"
            >
              Early access
            </Link>
          </div>
        </nav>

        <div className="relative z-20 mx-auto flex min-h-[calc(84svh-82px)] max-w-7xl flex-col justify-center px-5 pb-16 pt-12 md:px-8">
          <div className="max-w-3xl">
            <p className="mb-5 inline-flex items-center gap-2 border-b border-brand-gold/50 pb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-gold">
              <Icon type="compass" className="h-4 w-4" />
              Decision queue
            </p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-[1.04] tracking-tight text-white sm:text-5xl md:text-6xl md:leading-[1.02] lg:text-7xl">
              The clear signal worth acting on.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-stone-300 md:text-lg md:leading-8">
              Other AI agents act. Klorn helps you decide what's worth acting on. Mail, calendar,
              and AI signals filtered into one clear decision queue — with evidence and approval
              before anything leaves your hands.
            </p>
            <div className="mt-9 max-w-xl rounded-md border border-amber-300/30 bg-amber-300/5 p-4 text-sm leading-6 text-amber-100/90">
              <p className="flex items-start gap-2 font-semibold text-amber-100">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-amber-300">
                  🔒
                </span>
                Klorn is invite-only beta. You can't log in until I add your Google email as a test
                user.
              </p>
              <ol className="mt-3 space-y-1 pl-7 text-[13px] text-amber-100/80 list-decimal">
                <li>Request access below (takes 30 seconds).</li>
                <li>
                  I approve within 5 minutes when I'm awake (KST), within a few hours otherwise —
                  capped at 100 testers until Google CASA review clears.
                </li>
                <li>You get an email from noreply@klorn.ai. Then Log in works.</li>
              </ol>
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/early-access"
                aria-label="Request early access from hero"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-brand-gold px-6 text-sm font-semibold text-brand-ink transition hover:bg-brand-gold-bright"
              >
                Request early access
                <Icon type="arrow" className="h-4 w-4" />
              </Link>
              <Link
                href="/playground"
                aria-label="Try the classifier without signing up"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-stone-700 px-6 text-sm font-semibold text-stone-200 transition hover:border-stone-500 hover:text-white"
              >
                Try the live demo
                <Icon type="arrow" className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-1 px-1 text-sm text-stone-400 underline decoration-stone-700 underline-offset-4 transition hover:text-stone-200 hover:decoration-stone-400"
              >
                Already approved? Log in →
              </Link>
            </div>
          </div>

          <MobilePreview />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-16 pt-6 md:px-8 md:pb-24 md:pt-10">
        <div className="mx-auto mb-8 max-w-2xl text-center">
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-gold">
            Live demo
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
            Watch Klorn sort a real inbox.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-sm leading-7 text-stone-400 md:text-base">
            Every signal triaged into four tiers — push, queue, silent, and reversible
            auto-handling. Drafts wait for your approval before anything leaves your hands.
          </p>
        </div>

        <figure className="overflow-hidden rounded-xl border border-stone-600/70 bg-surface-elevated shadow-2xl shadow-black/40">
          <div className="flex h-11 items-center gap-2 border-b border-stone-800 px-4">
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-700" />
            <span className="ml-4 text-xs font-medium text-stone-500">Klorn / Today</span>
          </div>
          <video
            className="block aspect-video w-full bg-black"
            autoPlay
            muted
            loop
            playsInline
            controls
            preload="metadata"
            poster="/klorn-demo-poster.jpg"
            aria-label="Klorn walkthrough: an inbox is sorted into push, queue, silent, and auto-handled tiers, then Klorn drafts a calendar event and reply from a meeting request"
          >
            <source src="/klorn-walkthrough.webm" type="video/webm" />
            <source src="/klorn-walkthrough.mp4" type="video/mp4" />
          </video>
          <figcaption className="border-t border-stone-800 px-4 py-3 text-xs text-stone-500">
            One-minute walkthrough · recorded on a live build, June 2026
          </figcaption>
        </figure>
      </section>

      <section className="mx-auto grid max-w-7xl gap-10 px-5 py-20 md:grid-cols-[0.82fr_1.18fr] md:px-8 md:py-28">
        <div>
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-gold">
            Decision queue
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
            The important work fits on one card.
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-7 text-stone-400 md:text-base">
            Not another inbox. Just the decisions that have enough context to move.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-surface-translucent p-3 shadow-2xl shadow-black/30">
          <div className="rounded-md border border-white/8 bg-[#0d1014] p-4">
            <div className="mb-4 flex items-center justify-between gap-4 border-b border-white/8 pb-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-500">
                  Decision card
                </p>
                <h3 className="mt-1 text-lg font-semibold text-white">Investor follow-up ready</h3>
              </div>
              <span className="rounded border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                Approval needed
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
                className="h-11 rounded-md bg-brand-gold px-4 text-sm font-semibold text-brand-ink"
              >
                Approve
              </button>
              <button
                type="button"
                className="h-11 rounded-md border border-white/12 px-4 text-sm font-medium text-stone-300"
              >
                Edit first
              </button>
              <button
                type="button"
                className="h-11 rounded-md px-4 text-sm font-medium text-stone-500"
              >
                Hold
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/8 bg-[#11151a] text-stone-100">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-20 md:grid-cols-3 md:px-8 md:py-24">
          {pillars.map((pillar) => (
            <article key={pillar.label} className="border-t border-[#d7c9b6] pt-5">
              <div className="mb-8 flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-black/20 text-brand-gold">
                <Icon type={pillar.icon} className="h-5 w-5" />
              </div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand-gold">
                {pillar.label}
              </p>
              <h3 className="mt-3 text-2xl font-semibold tracking-tight">{pillar.title}</h3>
              <p className="mt-4 text-sm leading-7 text-stone-400">{pillar.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-28">
        <div className="grid gap-8 md:grid-cols-[0.8fr_1.2fr] md:items-start">
          <div>
            <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-gold">
              Operating principle
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">
              Prepare quietly. Confirm clearly.
            </h2>
          </div>
          <div className="grid overflow-hidden rounded-lg border border-white/10 md:grid-cols-4">
            {trustRows.map(([stage, body], index) => (
              <div
                key={stage}
                className="border-white/10 bg-white/[0.025] p-4 md:border-r md:last:border-r-0"
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-gold">
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
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-brand-gold">
          Built for decisions
        </p>
        <h2 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-6xl">
          The next inbox is a decision queue.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-sm leading-7 text-stone-400 md:text-base">
          Before the day gets noisy, align context, evidence, and action in one clean line.
        </p>
        <Link
          href="/early-access"
          aria-label="Request early access from final section"
          className="mt-9 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-brand-cream-soft px-6 text-sm font-semibold text-brand-ink transition hover:bg-white"
        >
          Request early access
          <Icon type="arrow" className="h-4 w-4" />
        </Link>
        <p className="mt-4 text-xs text-stone-500">Free during private beta.</p>
      </section>

      <footer className="border-t border-white/8 px-5 py-8 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 text-sm text-stone-500 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-7 w-7" />
            <span>Klorn — the clear signal worth acting on.</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="flex items-center gap-1">
              <a
                href="https://github.com/k08200/klorn"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Klorn on GitHub"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md transition hover:bg-white/[0.06] hover:text-stone-200"
              >
                <Icon type="github" className="h-5 w-5" />
              </a>
              <a
                href="https://x.com/klornai"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Klorn on X"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md transition hover:bg-white/[0.06] hover:text-stone-200"
              >
                <Icon type="x" className="h-[18px] w-[18px]" />
              </a>
              <a
                href="mailto:k0820086@gmail.com"
                aria-label="Email Klorn"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md transition hover:bg-white/[0.06] hover:text-stone-200"
              >
                <Icon type="mail" className="h-5 w-5" />
              </a>
              <a
                href="https://join.slack.com/t/klorn/shared_invite/zt-3zkj8lqxg-L4LK8dNPkzgupHEdmXgbIg"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Join the Klorn Slack"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md transition hover:bg-white/[0.06] hover:text-stone-200"
              >
                <Icon type="slack" className="h-[18px] w-[18px]" />
              </a>
            </div>
            <span className="hidden h-4 w-px bg-white/10 md:block" />
            <Link
              href="/privacy"
              className="inline-flex min-h-10 items-center transition hover:text-stone-300"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="inline-flex min-h-10 items-center transition hover:text-stone-300"
            >
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
