import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — EVE",
  description: "How EVE handles Gmail, Calendar, and account data during the beta.",
};

const updatedAt = "May 4, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <div className="space-y-3 text-sm leading-6 text-stone-300">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#10100d] text-white">
      <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-300 text-sm font-bold text-stone-950">
            E
          </div>
          <span className="text-lg font-bold tracking-tight">EVE</span>
        </Link>
        <div className="flex items-center gap-5 text-sm text-stone-400">
          <Link href="/terms" className="transition hover:text-white">
            Terms
          </Link>
          <Link href="/login" className="transition hover:text-white">
            Sign in
          </Link>
        </div>
      </nav>

      <article className="mx-auto max-w-4xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-200">
          Privacy Policy
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-5xl">
          How EVE handles your work data
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-stone-400">
          Last updated: {updatedAt}. EVE is currently in beta. This policy explains what data we
          access, why we access it, and how you can delete it.
        </p>

        <div className="mt-12 space-y-10">
          <Section title="What EVE is">
            <p>
              EVE is a Decision OS for work that helps users review Gmail, Calendar, tasks,
              reminders, notifications, and related work context so important replies, meetings, and
              follow-ups become easier to decide on.
            </p>
          </Section>

          <Section title="Data we collect">
            <p>When you use EVE, we may collect and store:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Account information, such as your email address and name.</li>
              <li>
                Google OAuth tokens needed to connect Gmail and Calendar, stored so EVE can sync in
                the background.
              </li>
              <li>
                Gmail metadata and content, such as sender, recipient, subject, snippet, message
                body, labels, read state, thread IDs, and AI-generated summaries or reply-needed
                signals.
              </li>
              <li>
                Calendar event information, such as title, time, attendees, location, and
                description.
              </li>
              <li>
                Product data you create in EVE, including tasks, reminders, notes, commitments,
                approval actions, feedback, notifications, and chat messages.
              </li>
              <li>
                Usage, token, error, and delivery logs needed to operate and improve the beta.
              </li>
            </ul>
          </Section>

          <Section title="How we use your data">
            <p>We use your data only to provide and improve EVE, including to:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Sync Gmail and Calendar after you connect Google.</li>
              <li>
                Generate morning briefings and identify emails or meetings that need attention.
              </li>
              <li>Create approval proposals, reminders, tasks, and notifications.</li>
              <li>Measure whether EVE&apos;s suggestions are useful during the beta.</li>
              <li>Debug reliability issues, prevent abuse, and keep the service secure.</li>
            </ul>
          </Section>

          <Section title="Google user data">
            <p>
              EVE requests Gmail and Calendar scopes so the product can read work context, identify
              important messages, manage calendar context, and prepare user-approved actions.
            </p>
            <p>
              EVE does not sell Google user data. EVE does not use Google user data for advertising.
              EVE does not transfer Google user data to unrelated third parties. EVE uses Google
              user data only to provide or improve user-facing EVE features.
            </p>
            <p>
              Email sending is treated as a sensitive action. During the beta, EVE does not silently
              send email replies on your behalf; email actions require user approval before sending.
            </p>
          </Section>

          <Section title="AI processing">
            <p>
              EVE may send relevant work context, such as email snippets, message bodies, calendar
              details, tasks, or notes, to AI model providers in order to summarize, classify,
              draft, or prioritize work. We send only the context needed for the feature being used.
            </p>
          </Section>

          <Section title="Data retention and deletion">
            <p>
              We retain account and workspace data while your account is active or as needed to
              operate the beta. You can request export or deletion of your data at any time.
            </p>
            <p>
              To delete your account data, contact{" "}
              <a className="text-amber-200 hover:text-amber-100" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              . Authenticated users may also use EVE&apos;s in-app data deletion endpoint. Deleting
              EVE data does not delete messages or calendar events from your Google account unless
              you explicitly approve such an action inside EVE.
            </p>
          </Section>

          <Section title="Security">
            <p>
              We use access controls, authentication, and operational safeguards to protect user
              data. Because EVE is in beta, please do not connect accounts containing information
              you are not comfortable using with a beta product.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions, deletion requests, or security concerns can be sent to{" "}
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
