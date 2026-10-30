import type { Metadata } from "next";
import Link from "next/link";
import { TIER_NAMES } from "@/lib/tiers";

export const metadata: Metadata = {
  title: "Privacy Policy - Klorn",
  description: "How Klorn handles Gmail, Calendar, and account data during beta.",
};

const updatedAt = "October 30, 2026";

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
  "Cookies and Local Storage",
  "How We Use Data",
  "Google User Data",
  "Your Rights (GDPR / CCPA)",
  "AI Processing",
  "Mobile App",
  "Retention and Deletion",
  "Security",
  "Contact",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section id={slug(title)} className="scroll-mt-24 space-y-3">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <div className="space-y-3 text-base leading-7 text-ink-mid">{children}</div>
    </section>
  );
}

function TableOfContents({ sections }: { sections: string[] }) {
  return (
    <nav
      aria-label="On this page"
      className="mt-10 rounded-xl border border-line bg-surface-raised p-5"
    >
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-ink-mid">On this page</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {sections.map((title) => (
          <li key={title}>
            <a
              href={`#${slug(title)}`}
              className="inline-flex min-h-11 items-center text-sm text-ink-mid transition hover:text-accent-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-1 focus-visible:ring-offset-white rounded"
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
    <main id="main" className="min-h-screen sky-bg text-ink">
      <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-[#f5f0e8]">
            <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9" />
          </div>
          <span className="text-lg font-bold tracking-tight">Klorn</span>
        </Link>
        <div className="flex items-center gap-5 text-sm text-ink-mid">
          <Link href="/terms" className="transition hover:text-ink">
            Terms
          </Link>
          <Link href="/login" className="transition hover:text-ink">
            Log in
          </Link>
        </div>
      </nav>

      <article className="mx-auto max-w-4xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-accent-deep">
          PRIVACY POLICY
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-ink md:text-5xl">
          How Klorn handles work data
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-ink-mid">
          Last updated: {updatedAt}. Klorn is currently a beta product. This policy explains what
          data Klorn can access, why it needs that access, and how you can request deletion.
        </p>

        <TableOfContents sections={SECTIONS} />

        <div className="mt-12 space-y-10">
          <Section title="What Klorn Does">
            <p>
              Klorn is an AI attention firewall for your email. It reviews Gmail and Calendar
              context, classifies incoming messages into attention tiers ({TIER_NAMES}), summarizes
              what matters into daily briefings, and prepares actions — replies, labels, archiving —
              that touch your mailbox only with your approval.
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
                If you link a secondary Google account, the same categories of data for that
                account. A calendar-only link grants read-only calendar access; a full inbox link
                grants Gmail access. Each linked account grants Klorn only the scopes shown on its
                own Google consent screen.
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
                If you connect a Naver mailbox over IMAP: the mailbox address and the Naver
                &ldquo;외부 메일 가져오기&rdquo; app password, plus the same categories of mail data
                as above for that mailbox. That app password is not your Naver account password, and
                it is encrypted at rest (AES-256-GCM) — never stored in plaintext.
              </li>
              <li>
                If you use the Klorn mobile app: the push token your device issues when you allow
                notifications, the device platform (iOS or Android), and, if you subscribe in the
                app, the store&apos;s record of that subscription.
              </li>
              <li>
                Usage, token, error, and delivery logs needed to operate and improve the beta.
              </li>
            </ul>
          </Section>

          <Section title="Cookies and Local Storage">
            <p>
              <strong>Klorn sets no cookies.</strong> The Klorn web app and this website write no
              cookies, the Klorn API sets none on any response, and no Klorn page loads third-party
              scripts, analytics, advertising tags or tracking pixels. There is nothing here to
              track you with across other sites, which is also why Klorn shows you no cookie consent
              banner — there is nothing to consent to.
            </p>
            <p>
              Klorn does use your browser&apos;s own local storage and session storage. This is data
              kept on your device by Klorn&apos;s own pages, not sent to anyone else, and you can
              erase all of it at any time by clearing site data for the Klorn domains in your
              browser. Anything in session storage is discarded as soon as you close the tab. Klorn
              uses it for the following, and nothing else.
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Keeping you signed in.</strong> Your session token is held in local storage
                and sent with each request to the Klorn API. It identifies your account, contains
                your email address, and expires 7 days after it is issued. Signing out deletes it.
              </li>
              <li>
                <strong>Protecting the sign-in itself.</strong> Short-lived, single-use values that
                tie a sign-in or an account link back to the browser that started it, so that
                another site cannot complete it on your behalf. They are deleted as soon as they are
                used, and expire within 5 to 15 minutes regardless.
              </li>
              <li>
                <strong>Remembering how you set things up</strong> — light or dark theme, app
                language, time zone, whether a panel is expanded, and the language you chose on the
                marketing site.
              </li>
              <li>
                <strong>Not losing your place.</strong> Which lane, mailbox and filter your mail
                list was showing, how far you had scrolled, the last message you opened, and where
                you had got to in first-run setup. This can include text you typed into mail search,
                capped at 200 characters and held only in session storage, so it is gone when the
                tab closes. Message bodies, subjects and draft replies are never written to browser
                storage.
              </li>
              <li>
                <strong>Not showing you a notice you already dismissed</strong> — the app install
                prompt, the push-notification banner, onboarding hints and the product survey card.
              </li>
              <li>
                <strong>Push notifications.</strong> A random identifier for this browser, so that a
                reissued push subscription replaces your old one instead of adding a duplicate. It
                is a random value and is not derived from you or from your device.
              </li>
              <li>
                <strong>Knowing how you found Klorn.</strong> On your first visit, the campaign
                parameters in the link you arrived through, the hostname of the site that referred
                you, and the page you landed on. It is capped at 300 characters and is sent to Klorn
                once, if you go on to create an account.
              </li>
              <li>
                <strong>The public playground.</strong> The playground at{" "}
                <Link className="text-accent-deep hover:text-accent-deeper" href="/playground">
                  /playground
                </Link>{" "}
                needs no account and runs on an AI provider key you supply yourself. That key is
                stored in your browser&apos;s local storage so you do not have to paste it again,
                and it is sent to the Klorn API, which uses it in memory for that one classification
                and then discards it — it is never written to Klorn&apos;s database, its logs or its
                error reporting. Emptying the key field removes it from your browser, as does
                signing out or clearing site data.
              </li>
            </ul>
            <p>
              Deleting your account clears Klorn&apos;s local storage in the browser you delete it
              from. Signing out clears the session token, any playground key and the mail view you
              were in, but deliberately leaves your preferences and dismissed notices in place, so
              that signing back in looks the way you left it.
            </p>
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
              <strong className="text-ink">Limited Use disclosure.</strong> Klorn's use and transfer
              to any other app of information received from Google APIs will adhere to{" "}
              <a
                className="text-accent-deep hover:text-accent-deeper"
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
              <strong className="text-ink">Scopes Klorn requests and why.</strong>
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <code className="text-ink">gmail.readonly</code> — read message metadata and bodies
                to classify priority, detect reply-needed signals, extract commitments and
                deadlines, and prepare daily briefings.
              </li>
              <li>
                <code className="text-ink">gmail.modify</code> — toggle read/star labels, archive,
                and move messages to trash (reversible) on commands you initiate or approve.
              </li>
              <li>
                <code className="text-ink">gmail.send</code> — send a reply only after you
                explicitly approve it. Every send is verified against a receipt of the exact content
                you approved.
              </li>
              <li>
                <code className="text-ink">calendar.events</code> — read upcoming events to surface
                meetings, link commitment due dates, and prepare meeting context. Edits require user
                approval.
              </li>
              <li>
                <code className="text-ink">calendar.readonly</code> — check availability across all
                your calendars to detect scheduling conflicts. When you link a secondary Google
                account for calendar visibility, this read-only scope is the only calendar access
                requested for it.
              </li>
              <li>
                <code className="text-ink">openid</code>,{" "}
                <code className="text-ink">userinfo.email</code>,{" "}
                <code className="text-ink">userinfo.profile</code> — sign you in and show which
                Google account is connected.
              </li>
            </ul>
          </Section>

          <Section title="Your Rights (GDPR / CCPA)">
            <p>
              Depending on where you live, you may have rights to access, correct, export, or delete
              the personal data Klorn holds about you, and to object to or restrict certain
              processing. To exercise any of these rights, contact{" "}
              <a
                className="text-accent-deep hover:text-accent-deeper"
                href="mailto:k0820086@gmail.com"
              >
                k0820086@gmail.com
              </a>
              . We respond within a reasonable time after verifying your identity. You may also
              revoke Klorn's Google access at any time from your{" "}
              <a
                className="text-accent-deep hover:text-accent-deeper"
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
            <p>
              Klorn&apos;s server-side AI providers are Anthropic (Claude API), Google (Gemini API)
              and OpenRouter, all used under API terms that exclude training on submitted data.
              Anthropic deletes API inputs and outputs within 30 days by default, longer only for
              content its usage-policy enforcement flags. If you bring your own API key or point a
              self-hosted Klorn at your own OpenAI-compatible endpoint, that provider is used only
              for your own requests.
            </p>
          </Section>

          <Section title="Mobile App">
            <p>
              The Klorn apps for iPhone, iPad and Android phones and tablets use the same account
              and the same data as the web app. On top of that:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-ink">Sign-in.</strong> Your session token is kept in the
                device&apos;s secure storage (the iOS Keychain or the Android Keystore) and is
                removed when you sign out.
              </li>
              <li>
                <strong className="text-ink">On-device cache.</strong> So the app opens instantly
                and works offline, the most recent screens you loaded — which can include mail
                senders, subjects, previews and calendar events — are cached in the app&apos;s
                private storage on the device for up to 24 hours, encrypted (AES-256) with a key
                that stays in this device&apos;s Keychain or Keystore and is never included in a
                backup or moved to a new phone — so a backup or a copied file cannot be read.
                Signing out deletes the cache and its key; uninstalling the app deletes the cache.
              </li>
              <li>
                <strong className="text-ink">Notifications.</strong> If you allow notifications,
                your device&apos;s push token is stored with your account. Notifications are
                delivered through Google Firebase Cloud Messaging and Apple Push Notification
                service, which receive the notification&apos;s title and text (this can include a
                sender&apos;s name and a subject line) and the ids the app needs to open the right
                message. They never receive your mailbox. You can turn notifications off in Klorn or
                in your device settings at any time.
              </li>
              <li>
                <strong className="text-ink">Subscriptions bought in the app.</strong> Purchases
                made in the app are processed by the App Store or Google Play under their own terms;
                Klorn never sees your card. RevenueCat, our subscription-management provider,
                receives the store&apos;s purchase record and your Klorn account id so your plan is
                applied to your account — never mail content. Manage or cancel the subscription in
                your App Store or Google Play account settings.
              </li>
              <li>
                <strong className="text-ink">Voice input.</strong> If you dictate to the assistant,
                your device&apos;s own speech recognizer (Apple or Google) handles the audio; Klorn
                receives only the resulting text.
              </li>
              <li>
                The app contains no advertising and no third-party analytics or tracking SDKs.
              </li>
            </ul>
          </Section>

          <Section title="Retention and Deletion">
            <p>
              We retain account and workspace data while your account is active. You can export your
              data or delete it at any time.
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-ink">Self-service deletion.</strong> You can delete your
                account and all associated data from Settings at any time. Deletion takes effect
                immediately: all Google-derived data — messages, summaries, calendar events, and
                OAuth tokens — is permanently removed from Klorn&apos;s database in the same
                operation.
              </li>
              <li>
                <strong className="text-ink">Access at Google.</strong> Deleting your data or
                account, or disconnecting a Google account in Klorn, also asks Google to revoke
                Klorn&apos;s access to that Google account, unless it is still connected elsewhere
                in Klorn (to your account or another one) or Klorn cannot confirm that it is not.
                The request is best effort: if it fails, or Google does not answer, access stays
                until you remove Klorn in your Google account settings.
              </li>
              <li>
                <strong className="text-ink">Export and workspace reset.</strong> Settings also
                offers a full data export and a workspace reset that deletes all synced and derived
                data while keeping your account.
              </li>
              <li>
                <strong className="text-ink">Backups.</strong> An encrypted copy of the database is
                taken every night, only to restore Klorn after a failure, and expires 14 days after
                it was taken. Data you delete leaves the database at once, and leaves the backups as
                the copies that hold it expire.
              </li>
              <li>
                <strong className="text-ink">Operational logs.</strong> Logs are deleted
                automatically on a fixed schedule: agent, email-processing, and
                notification-delivery logs after 90 days; push rate-limit records after 30 days;
                billing webhook records after 90 days; aggregate AI usage accounting after 180 days.
              </li>
            </ul>
            <p>
              To request deletion by email instead, contact{" "}
              <a
                className="text-accent-deep hover:text-accent-deeper"
                href="mailto:k0820086@gmail.com"
              >
                k0820086@gmail.com
              </a>
              . Deleting Klorn data does not delete messages or events from your Google account
              unless you explicitly approve that action inside Klorn.
            </p>
          </Section>

          <Section title="Security">
            <p>
              Klorn uses access controls, authentication, and operational safeguards to protect user
              data. Google OAuth tokens are encrypted at rest using AES-256-GCM. All data access is
              scoped to your account, transport is TLS-encrypted, and your Google user data is
              stored only in Klorn&apos;s own database and its encrypted backups — it is not shared
              with analytics or advertising services. Klorn&apos;s infrastructure sub-processors are
              Render (API hosting), Vercel (web application hosting), Supabase (managed Postgres
              database, hosted in Seoul, ap-northeast-2), and GitHub (storage of the nightly
              database backups: the database is copied to a temporary GitHub runner, encrypted
              there, and only the encrypted file is kept; the key to read it is never stored on
              GitHub); they store and transmit data solely to operate Klorn. Paddle acts as merchant
              of record for paid subscriptions and receives only billing details — never mail
              content. Resend delivers Klorn&apos;s own outgoing email (address verification,
              password reset, invitations, and the daily digest if you have it switched on) and
              therefore receives your address and the contents of those messages — never your
              mailbox. Apple (APNs) and Google (Firebase Cloud Messaging) deliver push notifications
              to devices you register. RevenueCat manages subscriptions bought in the mobile app and
              receives only purchase records and your Klorn account id.
            </p>
            <p>
              Because Klorn is a beta product, avoid connecting accounts that contain information
              you are not comfortable using with a beta service.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              For questions, deletion requests, or security concerns, contact{" "}
              <a
                className="text-accent-deep hover:text-accent-deeper"
                href="mailto:k0820086@gmail.com"
              >
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
