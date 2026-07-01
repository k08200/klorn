import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service - Klorn",
  description: "Klorn beta terms of service.",
};

const updatedAt = "May 4, 2026";

/** Stable, URL-safe anchor id so the TOC links line up with each section. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SECTIONS = [
  "Beta Product",
  "Your Responsibilities",
  "Approval and Automation",
  "Google Services",
  "Not Professional Advice",
  "Availability and Data Loss",
  "Limitation of Liability",
  "Governing Law",
  "Account Deletion",
  "Changes",
  "Contact",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section id={slug(title)} className="scroll-mt-24 space-y-3">
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <div className="space-y-3 text-base leading-7 text-stone-300">{children}</div>
    </section>
  );
}

function TableOfContents({ sections }: { sections: string[] }) {
  return (
    <nav
      aria-label="On this page"
      className="mt-10 rounded-xl border border-stone-800 bg-stone-950/40 p-5"
    >
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">On this page</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {sections.map((title) => (
          <li key={title}>
            <a
              href={`#${slug(title)}`}
              className="inline-flex min-h-11 items-center text-sm text-stone-300 transition hover:text-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-stone-950 rounded"
            >
              {title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function TermsPage() {
  return (
    <main id="main" className="min-h-screen bg-[#0f1115] text-white">
      <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-[#f5f0e8]">
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9" />
          </div>
          <span className="text-lg font-bold tracking-tight">Klorn</span>
        </Link>
        <div className="flex items-center gap-5 text-sm text-stone-400">
          <Link href="/privacy" className="transition hover:text-white">
            Privacy
          </Link>
          <Link href="/login" className="transition hover:text-white">
            Log in
          </Link>
        </div>
      </nav>

      <article className="mx-auto max-w-4xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-200">
          TERMS OF SERVICE
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-5xl">
          Klorn Beta Terms
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-stone-400">
          Last updated: {updatedAt}. These terms apply to the Klorn beta. By using Klorn, you agree
          to these terms and the Privacy Policy.
        </p>

        <TableOfContents sections={SECTIONS} />

        <div className="mt-12 space-y-10">
          <Section title="Beta Product">
            <p>
              Klorn is currently a beta product. Features may change, fail temporarily, be rate
              limited, or be removed. Klorn can make mistakes in summaries, classification,
              reminders, meeting preparation, and proposed actions.
            </p>
          </Section>

          <Section title="Your Responsibilities">
            <ul className="list-disc space-y-2 pl-5">
              <li>You are responsible for the accounts and data you connect to Klorn.</li>
              <li>Use Klorn only with accounts you own or are authorized to connect.</li>
              <li>Review important outputs before using or relying on them.</li>
              <li>
                Do not use Klorn in ways that violate law, contracts, privacy rights, or platform
                rules.
              </li>
            </ul>
          </Section>

          <Section title="Approval and Automation">
            <p>
              Klorn may create reminders, briefings, classifications, notifications, and approval
              proposals. Sensitive actions, including sending email, require your review and
              approval before execution. You are responsible for actions you approve.
            </p>
          </Section>

          <Section title="Google Services">
            <p>
              When you connect Gmail or Google Calendar, you authorize Klorn to access Google data
              needed to provide Klorn features. You can revoke Klorn's Google access at any time
              from your Google account settings.
            </p>
          </Section>

          <Section title="Not Professional Advice">
            <p>
              Klorn can help organize work, draft language, and prioritize decisions. Klorn does not
              provide legal, financial, medical, employment, or other professional advice. Verify
              important information before acting on it.
            </p>
          </Section>

          <Section title="Availability and Data Loss">
            <p>
              We work to keep Klorn reliable, but the beta is provided without uptime guarantees. We
              are not responsible for missed notifications, sync delays, inaccurate results, or data
              loss caused by beta limitations, third-party outages, or user configuration.
            </p>
          </Section>

          <Section title="Limitation of Liability">
            <p>
              To the maximum extent permitted by law, Klorn and its operators are not liable for
              indirect, incidental, special, consequential, or punitive damages, or any loss of
              profits, revenue, data, or goodwill arising from your use of Klorn. The total
              aggregate liability for any claim relating to Klorn is limited to the amount you paid
              for Klorn in the twelve months preceding the claim, or fifty US dollars if you paid
              nothing.
            </p>
          </Section>

          <Section title="Governing Law">
            <p>
              These terms are governed by the laws of the Republic of Korea, without regard to its
              conflict of laws principles. Any dispute arising from or related to these terms will
              be resolved in the courts located in Seoul, Republic of Korea, unless prohibited by
              applicable law.
            </p>
          </Section>

          <Section title="Account Deletion">
            <p>
              To request deletion of Klorn account data, contact{" "}
              <a className="text-amber-200 hover:text-amber-100" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              . Deleting Klorn account data does not automatically delete data from Google or other
              third-party services.
            </p>
          </Section>

          <Section title="Changes">
            <p>
              These terms may be updated as Klorn changes. If you continue using Klorn after an
              update, you agree to the updated terms.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              For questions about these terms, contact{" "}
              <a className="text-amber-200 hover:text-amber-100" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              .
            </p>
          </Section>
        </div>
      </article>
    </main>
  );
}
