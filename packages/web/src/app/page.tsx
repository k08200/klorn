import Link from "next/link";
import LandingRedirect from "../components/landing-redirect";

function Icon({ type }: { type: string }) {
  const p = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "zap":
      return (
        <svg aria-hidden="true" {...p}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "arrow":
      return (
        <svg aria-hidden="true" {...p}>
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      );
    case "connect":
      return (
        <svg aria-hidden="true" {...p}>
          <path d="M15 7h2a5 5 0 0 1 0 10h-2M9 17H7a5 5 0 0 1 0-10h2M8 12h8" />
        </svg>
      );
    case "autopilot":
      return (
        <svg aria-hidden="true" {...p}>
          <circle cx="12" cy="12" r="10" />
          <path d="m8 12 3 3 5-5" />
        </svg>
      );
    case "decide":
      return (
        <svg aria-hidden="true" {...p}>
          <path d="M2 3h20v18H2zM8 21V3M2 9h6M2 15h6" />
        </svg>
      );
    case "clock":
      return (
        <svg aria-hidden="true" {...p}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      );
    default:
      return null;
  }
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#06060a] text-white overflow-hidden">
      <LandingRedirect />

      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-5 max-w-6xl mx-auto">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-sm font-bold">
            E
          </div>
          <span className="text-lg font-bold tracking-tight">EVE</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm text-gray-400 hover:text-white transition px-3 py-1.5"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="text-sm bg-white text-black hover:bg-gray-200 px-5 py-2 rounded-lg font-medium transition"
          >
            Try Free
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative max-w-5xl mx-auto px-6 pt-28 pb-24 text-center">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-blue-600/8 rounded-full blur-[120px] pointer-events-none" />

        <div className="relative">
          <h1 className="text-5xl md:text-7xl font-bold leading-[1.08] tracking-tight mb-8">
            Your AI Chief
            <br />
            of Staff.
            <br />
            <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
              Without the $200K salary.
            </span>
          </h1>

          <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed mb-12">
            Founders hire a Chief of Staff to triage email, prep meetings, and run follow-ups. EVE
            does it for $29/mo — and never sleeps.
          </p>

          <Link
            href="/login"
            className="group inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-10 py-4 rounded-xl text-base font-medium transition-all shadow-lg shadow-blue-600/20 hover:shadow-blue-500/30"
          >
            Start Free
            <Icon type="arrow" />
          </Link>
          <p className="text-xs text-gray-600 mt-4">
            No credit card. Connect Gmail &amp; Calendar in one click.
          </p>
        </div>
      </section>

      {/* Human CoS vs EVE — the core pitch */}
      <section className="max-w-4xl mx-auto px-6 py-20">
        <h2 className="text-2xl md:text-3xl font-bold mb-2 text-center">
          Same job. One seven-hundredth of the cost.
        </h2>
        <p className="text-center text-gray-500 mb-10 text-sm">
          A human Chief of Staff handles a founder&apos;s inbox, calendar, and follow-ups. EVE
          handles the same surface — at a price you don&apos;t need a finance meeting to approve.
        </p>

        <div className="overflow-x-auto rounded-2xl border border-gray-800/50 bg-gray-900/40">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/60 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-5 py-3 font-medium">&nbsp;</th>
                <th className="text-left px-5 py-3 font-medium">Human CoS</th>
                <th className="text-left px-5 py-3 font-medium text-blue-300">EVE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60 text-gray-300">
              <tr>
                <td className="px-5 py-3 text-gray-500">Annual cost</td>
                <td className="px-5 py-3">$150K — $250K</td>
                <td className="px-5 py-3 text-white font-medium">$348</td>
              </tr>
              <tr>
                <td className="px-5 py-3 text-gray-500">Hours per week</td>
                <td className="px-5 py-3">40 — 60</td>
                <td className="px-5 py-3 text-white font-medium">168 (24/7)</td>
              </tr>
              <tr>
                <td className="px-5 py-3 text-gray-500">Onboarding</td>
                <td className="px-5 py-3">4 — 12 weeks</td>
                <td className="px-5 py-3 text-white font-medium">One OAuth click</td>
              </tr>
              <tr>
                <td className="px-5 py-3 text-gray-500">Sick days</td>
                <td className="px-5 py-3">5 — 10 / year</td>
                <td className="px-5 py-3 text-white font-medium">0</td>
              </tr>
              <tr>
                <td className="px-5 py-3 text-gray-500">Quits without notice</td>
                <td className="px-5 py-3">Sometimes</td>
                <td className="px-5 py-3 text-white font-medium">Never</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* The problem */}
      <section className="max-w-4xl mx-auto px-6 py-20">
        <div className="bg-gray-900/40 border border-gray-800/50 rounded-2xl p-8 md:p-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">
            You check 5 apps every morning.
            <br />
            <span className="text-gray-500">None of them tell you what to do first.</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
            <div>
              <p className="text-sm text-gray-500 uppercase tracking-wider mb-3">Without EVE</p>
              <ul className="space-y-2.5 text-sm text-gray-400">
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">&#10005;</span>
                  Open Gmail &mdash; 30 emails, which one matters?
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">&#10005;</span>
                  Open Calendar &mdash; 3 meetings, am I prepared?
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">&#10005;</span>
                  Open Todoist &mdash; 12 tasks, what&apos;s overdue?
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">&#10005;</span>
                  Spend 30 minutes just figuring out priorities
                </li>
              </ul>
            </div>
            <div>
              <p className="text-sm text-blue-400 uppercase tracking-wider mb-3">With EVE</p>
              <ul className="space-y-2.5 text-sm text-gray-300">
                <li className="flex items-start gap-2">
                  <span className="text-green-400 mt-0.5">&#10003;</span>
                  Wake up to a briefing already prepared
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-400 mt-0.5">&#10003;</span>
                  &ldquo;Investor replied &mdash; needs response by noon&rdquo;
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-400 mt-0.5">&#10003;</span>
                  &ldquo;2pm meeting &mdash; brief ready, no conflicts&rdquo;
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-400 mt-0.5">&#10003;</span>
                  Start your day knowing exactly what to do
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* How it works — 3 pillars */}
      <section className="max-w-5xl mx-auto px-6 py-20">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">How EVE works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gray-900/30 border border-gray-800/40 rounded-2xl p-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-blue-600/10 text-blue-400 flex items-center justify-center mx-auto mb-5">
              <Icon type="connect" />
            </div>
            <h3 className="text-lg font-semibold mb-3">1. Connect</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              Link your Gmail and Calendar with one click. EVE syncs everything automatically.
              That&apos;s the only setup.
            </p>
          </div>
          <div className="bg-gray-900/30 border border-gray-800/40 rounded-2xl p-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-emerald-600/10 text-emerald-400 flex items-center justify-center mx-auto mb-5">
              <Icon type="decide" />
            </div>
            <h3 className="text-lg font-semibold mb-3">2. EVE decides</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              EVE cross-references your email, calendar, and tasks to determine what&apos;s urgent,
              what&apos;s overdue, and what needs your attention.
            </p>
          </div>
          <div className="bg-gray-900/30 border border-gray-800/40 rounded-2xl p-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-amber-600/10 text-amber-400 flex items-center justify-center mx-auto mb-5">
              <Icon type="autopilot" />
            </div>
            <h3 className="text-lg font-semibold mb-3">3. EVE acts</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              Sends you a morning briefing. Alerts on urgent emails. Creates reminders for
              follow-ups. Drafts replies. All without being asked.
            </p>
          </div>
        </div>
      </section>

      {/* The 24/7 difference */}
      <section className="max-w-4xl mx-auto px-6 py-20">
        <div className="relative bg-gradient-to-br from-blue-950/40 to-gray-900/30 border border-blue-800/20 rounded-2xl p-8 md:p-12 overflow-hidden">
          <div className="absolute top-0 right-0 w-[300px] h-[300px] bg-blue-600/5 rounded-full blur-[80px] pointer-events-none" />
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center mb-6">
              <Icon type="clock" />
            </div>
            <h2 className="text-2xl md:text-3xl font-bold mb-4">
              EVE works while your computer is off.
            </h2>
            <p className="text-gray-400 leading-relaxed max-w-xl mb-8">
              Unlike local AI tools that stop when you close your laptop, EVE runs on the cloud
              24/7. An urgent email at 3am? EVE catches it and pushes a notification to your phone.
              By morning, your briefing is ready.
            </p>
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <p className="text-2xl font-bold text-white">24/7</p>
                <p className="text-gray-500">Always running</p>
              </div>
              <div className="w-px h-12 bg-gray-800" />
              <div>
                <p className="text-2xl font-bold text-white">1</p>
                <p className="text-gray-500">Click to set up</p>
              </div>
              <div className="w-px h-12 bg-gray-800" />
              <div>
                <p className="text-2xl font-bold text-white">3 min</p>
                <p className="text-gray-500">To first briefing</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* What EVE does autonomously */}
      <section className="max-w-5xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-center mb-4">What EVE does without being told</h2>
        <p className="text-gray-500 text-center mb-14 max-w-lg mx-auto">
          These happen automatically after you connect your accounts.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { action: "Morning briefing", desc: "Summarizes your day every morning" },
            { action: "Email triage", desc: "Classifies 30+ emails by priority in seconds" },
            { action: "Urgent alerts", desc: "Pushes notifications for time-sensitive emails" },
            { action: "Overdue detection", desc: "Flags tasks past their deadline" },
            { action: "Meeting prep", desc: "Prepares briefs before your calendar events" },
            {
              action: "Follow-up reminders",
              desc: "Creates reminders for emails you haven't replied to",
            },
          ].map((item) => (
            <div
              key={item.action}
              className="flex items-start gap-3 bg-gray-900/30 border border-gray-800/40 rounded-xl p-5"
            >
              <span className="text-blue-400 mt-0.5 flex-shrink-0">
                <Icon type="autopilot" />
              </span>
              <div>
                <p className="text-sm font-medium text-white">{item.action}</p>
                <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative max-w-5xl mx-auto px-6 py-32 text-center">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] bg-blue-600/6 rounded-full blur-[100px] pointer-events-none" />
        <div className="relative">
          <h2 className="text-4xl md:text-5xl font-bold mb-6 leading-tight">
            Stop checking.
            <br />
            Start knowing.
          </h2>
          <p className="text-lg text-gray-500 mb-10 max-w-lg mx-auto">
            Connect your Gmail and Calendar. EVE takes it from there.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-white text-black hover:bg-gray-200 px-10 py-4 rounded-xl text-sm font-semibold transition-all shadow-lg"
          >
            Get Started Free
            <Icon type="arrow" />
          </Link>
          <p className="text-xs text-gray-600 mt-4">No credit card required</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800/30 py-10 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">
              E
            </div>
            <span>EVE &mdash; Connect once. EVE handles the rest.</span>
          </div>
          <div className="flex items-center gap-6 text-xs text-gray-600">
            <Link href="/early-access" className="hover:text-gray-300 transition">
              Early Access
            </Link>
            <Link href="/privacy" className="hover:text-gray-300 transition">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-gray-300 transition">
              Terms
            </Link>
            <Link href="/login" className="hover:text-gray-300 transition">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
