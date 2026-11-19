import { type CreateEmailOptions, Resend } from "resend";
import { EMAIL_VERIFY_TOKEN_TTL_MS } from "../one-time-token.js";
import { captureDbFailure, logDbFailure } from "../report-db-failure.js";
import { addressLogTag } from "../security/address-log-tag.js";
import { PASSWORD_RESET_TOKEN_TTL_MS } from "../security/password-reset-throttle.js";
import { captureError } from "../sentry.js";
import { digestUnsubscribeLabel, digestUnsubscribeUrl } from "./digest-unsubscribe.js";
import { parseAddress } from "./email-address.js";
import {
  type ResendRequestOptions,
  ResendSendError,
  requireResendAccepted,
} from "./resend-send.js";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || "Klorn <onboarding@resend.dev>";
const WEB_URL = process.env.WEB_URL || "http://localhost:8001";

/**
 * One send for requireResendAccepted: the payload now, the abort signal (and
 * idempotency key) when it runs, so every send is bounded (resend-send.ts).
 */
function sendThrough(client: Resend, payload: CreateEmailOptions) {
  return (options: ResendRequestOptions) => client.emails.send(payload, options);
}

/** Extract the bare address from a `Name <addr@x>` header, or pass through. */
function addressOf(fromHeader: string): string {
  return parseAddress(fromHeader);
}

/** Strip angle brackets so a name can't break out of an HTML/email header. */
function stripBrackets(value: string): string {
  return value.replace(/[<>]/g, "").trim();
}

/** Escape text for safe interpolation into an HTML body/attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collapse CR/LF/TAB so an env-derived value can't inject email headers. */
function stripHeaderControls(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").trim();
}

/** Pass through only http(s) URLs; reject javascript:/data: and garbage. */
function safeHttpUrl(raw: string | undefined | null): string | null {
  const value = (raw || "").trim();
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A link lifetime in the mail's words: "1 hour", "2 hours", "30 minutes".
 * Whole hours read as hours; anything else as whole minutes, rounded down so
 * the mail never promises longer than the link lives.
 */
export function formatLinkLifetime(ms: number): string {
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) {
    const hours = ms / HOUR_MS;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * What became of one mail, for the senders whose callers retry:
 * - `sent`: Resend accepted it.
 * - `skipped`: nothing was sent and nothing was wrong with the mail (Resend
 *   unconfigured, or no opt-out target for the digest); the caller decides.
 * - `failed`: not sent, worth retrying (rate limit, quota, 5xx, network, no
 *   answer in time, Klorn's own key or domain; resend-send.ts).
 * - `rejected`: Resend refused this mail for good (a malformed field or a
 *   recipient it will not take); sending it again gets the same refusal.
 */
export type MailSendResult = "sent" | "skipped" | "failed" | "rejected";

/** The failure class of a caught send error; anything but a permanent refusal is retryable. */
function failureResult(err: unknown): "failed" | "rejected" {
  return err instanceof ResendSendError && err.permanent ? "rejected" : "failed";
}

/** What the admin who approved a waitlist entry is told about the invite mail. */
export type InviteEmailReport = { sent: true } | { sent: false; code: string };

export async function sendPasswordResetEmail(to: string, resetToken: string): Promise<boolean> {
  const resetUrl = `${WEB_URL}/reset-password?token=${resetToken}`;
  const addressTag = addressLogTag(to);

  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — reset link generated for", addressTag);
    return true;
  }

  try {
    // The caller puts the previous reset link back when this mail did not go
    // out (resend-send.ts: a refusal is an answer, not a throw).
    await requireResendAccepted(
      sendThrough(resend, {
        from: FROM_EMAIL,
        to,
        subject: "Reset your Klorn password",
        html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #0ea5e9; margin-bottom: 24px;">Klorn</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            You requested a password reset. Click the button below to set a new password.
          </p>
          <a href="${resetUrl}" style="display: inline-block; background: #0ea5e9; color: #10100d; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Reset Password
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This link expires in ${formatLinkLifetime(PASSWORD_RESET_TOKEN_TTL_MS)}. If you didn't request this, ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Klorn — the clear signal worth acting on
          </p>
        </div>
      `,
      }),
    );
    console.log("[EMAIL] Password reset email sent to", addressTag);
    return true;
  } catch (err) {
    logDbFailure("[EMAIL] Failed to send reset email", err, { level: "error" });
    return false;
  }
}

/**
 * The "you're approved" mail. Never throws: the admin route awaits it and
 * hands the report to the admin, so a mail that did not go out is visible
 * where the approval was made (routes/admin.ts).
 */
export async function sendBetaInviteEmail(
  to: string,
  name?: string | null,
): Promise<InviteEmailReport> {
  const loginUrl = `${WEB_URL}/login`;
  const addressTag = addressLogTag(to);
  const safeName = name?.trim()?.replace(/[<>]/g, "");
  const greeting = safeName ? `Hi ${escapeHtml(safeName)},` : "Hi,";

  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — invite not sent to", addressTag);
    return { sent: false, code: "RESEND_NOT_CONFIGURED" };
  }

  try {
    await requireResendAccepted(
      sendThrough(resend, {
        from: FROM_EMAIL,
        to,
        subject: "You're approved — sign in to Klorn",
        html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #0ea5e9; margin-bottom: 24px;">You're approved</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            ${greeting}
          </p>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            You're approved. Sign in with this address: <strong style="color: #111827;">${escapeHtml(to)}</strong>.
          </p>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            Open the login page below and click <strong>Continue with Google</strong> using this exact address. Klorn will connect your Gmail and Calendar and sort your mail so only what needs you interrupts you.
          </p>
          <a href="${loginUrl}" style="display: inline-block; background: #0ea5e9; color: #10100d; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Open Klorn → Continue with Google
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            Heads-up: Klorn spends the first couple of days learning your patterns. Tell it "less" or "more" on any item and the tier policy adjusts.
          </p>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            Found a bug or hit friction? Just reply to this email — I read every one personally and turn around fixes in hours, not weeks.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Klorn — the clear signal worth acting on
          </p>
        </div>
      `,
      }),
    );
    console.log("[EMAIL] Beta invite email sent to", addressTag);
    return { sent: true };
  } catch (err) {
    logDbFailure("[EMAIL] Failed to send invite email", err, { level: "error" });
    return { sent: false, code: err instanceof ResendSendError ? err.code : "SEND_FAILED" };
  }
}

const INVITE_NAME_MAX = 80;

/**
 * Klorn Teams invite (org/org-invites.ts). The raw token rides in the URL
 * fragment, which browsers never send to a server, so it stays out of access
 * logs and Referer headers; the accept page posts it in a request body. The
 * organization and inviter names are user text: escaped for HTML and stripped
 * of header controls for the subject. Returns false when the mail did not go
 * out (Resend refused it, failed, or threw).
 */
export async function sendOrgInviteEmail(input: {
  to: string;
  token: string;
  orgName: string;
  inviterName: string | null;
}): Promise<boolean> {
  const addressTag = addressLogTag(input.to);
  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — organization invite generated for", addressTag);
    return true;
  }
  const acceptUrl = `${WEB_URL}/team-invite#token=${encodeURIComponent(input.token)}`;
  const org = stripHeaderControls(input.orgName).slice(0, INVITE_NAME_MAX);
  const inviter = input.inviterName
    ? stripHeaderControls(input.inviterName).slice(0, INVITE_NAME_MAX)
    : null;
  const lead = inviter
    ? `${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(org)}</strong> on Klorn.`
    : `You were invited to join <strong>${escapeHtml(org)}</strong> on Klorn.`;
  try {
    await requireResendAccepted(
      sendThrough(resend, {
        from: FROM_EMAIL,
        to: input.to,
        subject: `Join ${org} on Klorn`,
        html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #0ea5e9; margin-bottom: 24px;">Klorn</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">${lead}</p>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            Sign in with this address (<strong>${escapeHtml(input.to)}</strong>) to accept.
            Your organization never sees your mail. It sees your name, role and seat, and
            your busy times only if you choose to share them.
          </p>
          <a href="${escapeHtml(acceptUrl)}" style="display: inline-block; background: #0ea5e9; color: #10100d; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Review the invite
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This invite expires in 7 days and works once. If you did not expect it, ignore this email.
          </p>
        </div>
      `,
      }),
    );
    console.log("[EMAIL] Organization invite sent to", addressTag);
    return true;
  } catch (err) {
    logDbFailure("[EMAIL] Failed to send organization invite", err, { level: "error" });
    return false;
  }
}

export async function sendVerificationEmail(to: string, verifyToken: string): Promise<boolean> {
  const verifyUrl = `${WEB_URL}/verify-email?token=${verifyToken}`;
  const addressTag = addressLogTag(to);

  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — verify link generated for", addressTag);
    return true;
  }

  try {
    await requireResendAccepted(
      sendThrough(resend, {
        from: FROM_EMAIL,
        to,
        subject: "Verify your Klorn account",
        html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #0ea5e9; margin-bottom: 24px;">Klorn</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            Welcome to Klorn! Please verify your email address to get started.
          </p>
          <a href="${verifyUrl}" style="display: inline-block; background: #0ea5e9; color: #10100d; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Verify Email
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This link expires in ${formatLinkLifetime(EMAIL_VERIFY_TOKEN_TTL_MS)}.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Klorn — the clear signal worth acting on
          </p>
        </div>
      `,
      }),
    );
    console.log("[EMAIL] Verification email sent to", addressTag);
    return true;
  } catch (err) {
    logDbFailure("[EMAIL] Failed to send verification email", err, { level: "error" });
    return false;
  }
}

/** Founder identity for the welcome email, resolved from env. */
export interface FounderIdentity {
  /** Display name used in the From header and signoff. Empty → team voice. */
  name: string;
  /** Title printed under the signoff (only when a founder name is set). */
  title: string;
  /** Optional community link (Slack/Discord). Omitted from the body if empty. */
  communityUrl: string | null;
}

export function resolveFounder(): FounderIdentity {
  return {
    name: stripHeaderControls(stripBrackets(process.env.FOUNDER_NAME || "")),
    title: stripHeaderControls(stripBrackets(process.env.FOUNDER_TITLE || "Founder")) || "Founder",
    communityUrl: safeHttpUrl(process.env.COMMUNITY_URL),
  };
}

/** First name for the greeting: first token of the name, else the email local part. */
function greetingName(name: string | null | undefined, email: string): string {
  const first = stripBrackets(name ?? "").split(/\s+/)[0];
  if (first) return first;
  const local = stripBrackets(email.split("@")[0] ?? "");
  return local || "there";
}

export interface WelcomeEmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Pure builder for the founder welcome email — no I/O, so it is unit-tested
 * directly. Mirrors a personal founder note: greeting by first name, why it
 * exists, one question, an optional community link, and a reply-to-me signoff.
 */
export function buildWelcomeEmail(
  to: string,
  name: string | null | undefined,
  founder: FounderIdentity,
): WelcomeEmailContent {
  const first = greetingName(name, to);
  const hasFounder = founder.name.length > 0;
  const intro = hasFounder
    ? `I'm ${founder.name}, and I build Klorn.`
    : "I'm on the team that builds Klorn.";
  const why =
    "I made it because most inboxes interrupt you for everything. Klorn only interrupts you for what's actually worth it, and quietly handles the rest.";
  const community = founder.communityUrl;

  const textLines = [
    `Hey ${first},`,
    "",
    "I saw you just got set up — that's genuinely good to see.",
    `${intro} ${why}`,
    "",
    "Quick question — what's the one thing you want Klorn to get right for you?",
    "I'd really like to know. Just hit reply; it comes straight to me.",
  ];
  if (community) {
    textLines.push("", `Want to talk it through? Come say hi here: ${community}`);
  }
  textLines.push("", "Thanks for giving it a try.", "");
  if (hasFounder) {
    textLines.push(`— ${founder.name}`, `${founder.title}, Klorn`);
  } else {
    textLines.push("— The Klorn team");
  }

  const signoffHtml = hasFounder
    ? `— ${escapeHtml(founder.name)}<br />${escapeHtml(founder.title)}, Klorn`
    : "— The Klorn team";
  const communityHtml = community
    ? `<p>Want to talk it through? <a href="${escapeHtml(community)}" style="color: #b9742f;">Come say hi here</a>.</p>`
    : "";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
      <p>Hey ${escapeHtml(first)},</p>
      <p>I saw you just got set up — that's genuinely good to see.</p>
      <p>${escapeHtml(intro)} ${escapeHtml(why)}</p>
      <p><strong>Quick question — what's the one thing you want Klorn to get right for you?</strong><br />I'd really like to know. Just hit reply; it comes straight to me.</p>
      ${communityHtml}
      <p>Thanks for giving it a try.</p>
      <p style="color: #6b7280;">${signoffHtml}</p>
    </div>
  `;

  return { subject: "Welcome to Klorn", html, text: textLines.join("\n") };
}

/**
 * Outcome of a welcome-email attempt (MailSendResult). The caller releases its
 * once-per-user claim on `skipped` (Resend unconfigured: a missing key must
 * not permanently suppress the welcome) and on `failed` (retry on a later
 * sign-in), and keeps it on `rejected`: Resend will refuse the same address
 * again, so retrying on every sign-in only repeats the refusal.
 */
export type WelcomeSendResult = MailSendResult;

/** Send the founder welcome email via Resend. See WelcomeSendResult. */
export async function sendWelcomeEmail(
  to: string,
  name?: string | null,
  opts: { idempotencyKey?: string } = {},
): Promise<WelcomeSendResult> {
  const addressTag = addressLogTag(to);
  const founder = resolveFounder();
  const content = buildWelcomeEmail(to, name, founder);

  if (!resend) {
    console.warn("[EMAIL] No RESEND_API_KEY — welcome email skipped for", addressTag);
    return "skipped";
  }

  // From the founder by display name when configured (e.g. "Ada <hi@klorn.ai>"),
  // otherwise the brand From. Reply-to routes "just hit reply" to a real inbox:
  // explicit override → first ADMIN_EMAILS → the From address as last resort.
  // founder.name and replyTo are already control-char-stripped in resolveFounder
  // / below, so neither can inject an email header.
  const fromAddress = addressOf(process.env.WELCOME_FROM_EMAIL || FROM_EMAIL);
  const from = founder.name ? `${founder.name} <${fromAddress}>` : FROM_EMAIL;
  const adminEmail = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  const replyTo =
    stripHeaderControls(process.env.FOUNDER_REPLY_TO || "") || adminEmail || fromAddress;

  try {
    await requireResendAccepted(
      sendThrough(resend, {
        from,
        to,
        replyTo,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
      { idempotencyKey: opts.idempotencyKey },
    );
    console.log("[EMAIL] Welcome email sent to", addressTag);
    return "sent";
  } catch (err) {
    // Log + capture the REAL Resend error here so Sentry gets the actual cause
    // and stack, not a synthetic one reconstructed by the caller.
    logDbFailure("[EMAIL] Failed to send welcome email", err, { level: "error" });
    captureDbFailure("[EMAIL] Failed to send welcome email", err, {
      tags: { scope: "email.welcome-send" },
    });
    return failureResult(err);
  }
}

/**
 * Send one daily-digest mail.
 *
 * Plain text is the payload; the HTML part is the same text in a monospace
 * block, escaped. A digest is a list of addresses and counts — there is nothing
 * here that a layout would make clearer, and an address rendered as unescaped
 * HTML is an injection waiting to happen.
 *
 * This is the one sender in this module that recurs on a schedule, so it is the
 * one that carries an opt-out: in the plain-text part (which had none at all —
 * a text-only client saw no way out), in the HTML part, and in the
 * `List-Unsubscribe` header that Gmail weights when it decides whether Klorn's
 * mail is wanted. The transactional senders above (reset, verify, invite)
 * deliberately carry none: an unsubscribe control on a password reset offers to
 * stop a mail that is only ever sent because the user just asked for it.
 *
 * No `List-Unsubscribe-Post`: that header promises RFC 8058 one-click, which
 * requires an endpoint that unsubscribes on an unauthenticated POST. This link
 * goes to the user's own settings instead, so advertising one-click would be a
 * header that lies about what the URL does.
 *
 * `webUrl` is the caller's, not this module's: pim/daily-digest.ts already owns
 * "where the digest points" for the links inside the body, and reading the env
 * var separately here let the two disagree — an unset WEB_URL pointed the body
 * at the deployed app and the opt-out at localhost.
 *
 * If no usable opt-out URL can be built, the mail is NOT sent. A recurring mail
 * with no way out is the exact thing this function exists to prevent, so a
 * misconfigured WEB_URL has to cost a skipped digest rather than silently
 * produce the non-compliant mail the old code would have sent. The digest is a
 * safety net, and the sweep already tolerates a skipped send per user.
 *
 * Answers a MailSendResult rather than throwing: the digest sweep runs over
 * every user, and one bad address must not end it. `skipped` covers both
 * refusals above (no Resend key, no opt-out target); the sweep retries only
 * `failed` (pim/daily-digest.ts), under the caller's idempotency key.
 */
export async function sendDigestEmail(
  to: string,
  subject: string,
  text: string,
  opts: { language?: string; webUrl?: string; idempotencyKey?: string } = {},
): Promise<MailSendResult> {
  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — digest not sent to", addressLogTag(to));
    return "skipped";
  }
  const unsubscribeUrl = digestUnsubscribeUrl(opts.webUrl ?? WEB_URL);
  if (!unsubscribeUrl) {
    console.error(
      "[EMAIL] digest NOT sent to",
      addressLogTag(to),
      "— WEB_URL yields no usable unsubscribe target; refusing to send a recurring mail with no opt-out",
    );
    captureError(new Error("digest unsubscribe URL unavailable"), {
      tags: { scope: "digest-email" },
    });
    return "skipped";
  }
  const label = digestUnsubscribeLabel(opts.language ?? "en");
  try {
    await requireResendAccepted(
      sendThrough(resend, {
        from: FROM_EMAIL,
        to,
        subject,
        // The opt-out is part of the text payload, not a decoration on the HTML
        // part: a client that shows only text/plain must still see a way out.
        text: `${text}\n\n—\n${label}: ${unsubscribeUrl}`,
        html:
          `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;` +
          `margin:0 auto;padding:32px 20px;color:#374151;font-size:15px;line-height:1.6">` +
          `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre>` +
          `<p style="color:#6b7280;font-size:13px;margin-top:28px">` +
          `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">${escapeHtml(label)}</a></p>` +
          `</div>`,
        headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` },
      }),
      { idempotencyKey: opts.idempotencyKey },
    );
    return "sent";
  } catch (err) {
    logDbFailure("[EMAIL] digest send failed", err);
    captureDbFailure("[EMAIL] digest send failed", err, { tags: { scope: "digest-email" } });
    return failureResult(err);
  }
}
