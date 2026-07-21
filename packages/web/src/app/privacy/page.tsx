import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy - Klorn",
  description: "How Klorn handles Gmail, Calendar, and account data during beta.",
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
  "What Klorn Does",
  "Data We Collect",
  "How We Use Data",
  "Google User Data",
  "Your Rights (GDPR / CCPA)",
  "AI Processing",
  "Retention and Deletion",
  "Security",
  "Contact",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section id={slug(title)} className="scroll-mt-24 space-y-3">
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
      <div className="space-y-3 text-base leading-7 text-slate-500">{children}</div>
    </section>
  );
}

function TableOfContents({ sections }: { sections: string[] }) {
  return (
    <nav
      aria-label="On this page"
      className="mt-10 rounded-xl border border-slate-200 bg-slate-50 p-5"
    >
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">On this page</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {sections.map((title) => (
          <li key={title}>
            <a
              href={`#${slug(title)}`}
              className="inline-flex min-h-11 items-center text-sm text-slate-500 transition hover:text-sky-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-white rounded"
            >
              {title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function PrivacyPage() {
  return (
    <main id="main" className="min-h-screen bg-white text-slate-900">
      <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-[#f5f0e8]">
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9" />
          </div>
          <span className="text-lg font-bold tracking-tight">Klorn</span>
        </Link>
        <div className="flex items-center gap-5 text-sm text-slate-500">
          <Link href="/terms" className="transition hover:text-slate-900">
            Terms
          </Link>
          <Link href="/login" className="transition hover:text-slate-900">
            Log in
          </Link>
        </div>
      </nav>

      <article className="mx-auto max-w-4xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-sky-600">
          PRIVACY POLICY
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 md:text-5xl">
          How Klorn handles work data
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-slate-500">
          Last updated: {updatedAt}. Klorn is currently a beta product. This policy explains what
          data Klorn can access, why it needs that access, and how you can request deletion.
        </p>

        <TableOfContents sections={SECTIONS} />

        <div className="mt-12 space-y-10">
          <Section title="What Klorn Does">
            <p>
              Klorn is a work Decision OS that reviews Gmail, Calendar, tasks, reminders,
              notifications, and related work context so important replies, meetings, and follow-ups
              are easier to decide on.
            </p>
          </Section>

          <Section title="Data We Collect">
            <p>When you use Klorn, we may collect or store the following data.</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Account information such as email address and name.</li>
              <li>
                Google OAuth tokens needed to connect Gmail and Calendar and run background sync.
              </li>
              <li>
                Gmail metadata and content such as sender, recipients, subject, snippet, body,
                labels, read state, thread ID, AI-generated summaries, and reply-needed signals.
              </li>
              <li>
                Calendar event information such as title, time, attendees, location, and
                description.
              </li>
              <li>
                Product data you create in Klorn, including tasks, reminders, notes, commitments,
                approved actions, feedback, notifications, and chat messages.
              </li>
              <li>
                Usage, token, error, and delivery logs needed to operate and improve the beta.
              </li>
            </ul>
          </Section>

          <Section title="How We Use Data">
            <p>Klorn uses data only to provide and improve the product. Examples include:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Syncing Gmail and Calendar after you connect Google.</li>
              <li>Creating morning briefings and finding messages or meetings that need review.</li>
              <li>Preparing approval proposals, reminders, tasks, and notifications.</li>
              <li>Measuring whether Klorn suggestions are useful during beta.</li>
              <li>Debugging reliability issues, preventing abuse, and protecting the service.</li>
            </ul>
          </Section>

          <Section title="Google User Data">
            <p>
              Klorn requests Gmail and Calendar permissions to read work context, identify important
              messages, understand calendar context, and prepare actions for your approval.
            </p>
            <p>
              Klorn does not sell Google user data, use it for advertising, or transfer it to
              unrelated third parties. Google user data is used only to provide or improve the Klorn
              features you see.
            </p>
            <p>
              Email sending is treated as a sensitive action. During beta, Klorn does not send
              replies without your awareness. Email actions require your approval before sending.
            </p>
            <p>
              <strong className="text-slate-900">Limited Use disclosure.</strong> Klorn's use and
              transfer to any other app of information received from Google APIs will adhere to{" "}
              <a
                className="text-sky-600 hover:text-sky-700"
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noreferrer"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements. Specifically: Klorn does not transfer Google
              user data to third parties except as necessary to provide or improve user-facing
              features, comply with applicable law, or as part of a merger or acquisition; Klorn
              does not use Google user data for serving ads; Klorn does not allow humans to read
              Google user data unless we obtain affirmative agreement from the user, it is necessary
              for security purposes, to comply with applicable law, or the data is aggregated and
              used for internal operations in accordance with the Limited Use requirements; and
              Klorn does not use Google user data to develop, improve, or train generalized or
              non-personalized AI and/or ML models. Any AI processing of Google user data is
              performed only to provide the user-facing features you request, on a per-message
              basis, and is not used to train the AI providers' models.
            </p>
            <p>
              <strong className="text-slate-900">Scopes Klorn requests and why.</strong>
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <code className="text-slate-900">gmail.readonly</code> — read message metadata and
                bodies to classify priority, detect reply-needed signals, extract commitments and
                deadlines, and prepare daily briefings.
              </li>
              <li>
                <code className="text-slate-900">gmail.modify</code> — toggle read/star labels and
                archive on user-initiated commands; send replies only when the user explicitly
                approves a draft.
              </li>
              <li>
                <code className="text-slate-900">calendar.events</code> — read upcoming events to
                surface meetings, link commitment due dates, and prepare meeting context. Edits
                require user approval.
              </li>
            </ul>
          </Section>

          <Section title="Your Rights (GDPR / CCPA)">
            <p>
              Depending on where you live, you may have rights to access, correct, export, or delete
              the personal data Klorn holds about you, and to object to or restrict certain
              processing. To exercise any of these rights, contact{" "}
              <a className="text-sky-600 hover:text-sky-700" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              . We respond within a reasonable time after verifying your identity. You may also
              revoke Klorn's Google access at any time from your{" "}
              <a
                className="text-sky-600 hover:text-sky-700"
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noreferrer"
              >
                Google account permissions
              </a>
              .
            </p>
          </Section>

          <Section title="AI Processing">
            <p>
              Klorn may send relevant work context such as email snippets, bodies, calendar details,
              tasks, and notes to AI model providers for summarization, classification, drafting,
              and prioritization. We send only the context needed for the feature you are using.
              This processing happens per request to produce the result you asked for; your Google
              user data is never used to develop, improve, or train generalized or non-personalized
              AI or ML models, and we configure our AI providers under API terms that do not train
              their models on the data we send.
            </p>
          </Section>

          <Section title="Retention and Deletion">
            <p>
              We retain account and workspace data while your account is active or while it is
              needed to operate the beta. You can request export or deletion at any time.
            </p>
            <p>
              To request account data deletion, contact{" "}
              <a className="text-sky-600 hover:text-sky-700" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              . Authenticated users may also use in-product deletion controls where available.
              Deleting Klorn data does not delete messages or events from your Google account unless
              you explicitly approve that action inside Klorn.
            </p>
          </Section>

          <Section title="Security">
            <p>
              Klorn uses access controls, authentication, and operational safeguards to protect user
              data. Because Klorn is a beta product, avoid connecting accounts that contain
              information you are not comfortable using with a beta service.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              For questions, deletion requests, or security concerns, contact{" "}
              <a className="text-sky-600 hover:text-sky-700" href="mailto:k0820086@gmail.com">
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
