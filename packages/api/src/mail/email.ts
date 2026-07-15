import { Resend } from "resend";
import { captureError } from "../sentry.js";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || "Klorn <onboarding@resend.dev>";
const WEB_URL = process.env.WEB_URL || "http://localhost:8001";

/** Mask email for safe logging: "user@example.com" → "u***@example.com" */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return email[0] + "***" + email.slice(at);
}

/** Extract the bare address from a `Name <addr@x>` header, or pass through. */
function addressOf(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim();
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

export async function sendPasswordResetEmail(to: string, resetToken: string): Promise<boolean> {
  const resetUrl = `${WEB_URL}/reset-password?token=${resetToken}`;
  const safeAddr = maskEmail(to);

  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — reset link generated for", safeAddr);
    return true;
  }

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "Reset your Klorn password",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #d8a45d; margin-bottom: 24px;">Klorn</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            You requested a password reset. Click the button below to set a new password.
          </p>
          <a href="${resetUrl}" style="display: inline-block; background: #d8a45d; color: #10100d; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Reset Password
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This link expires in 1 hour. If you didn't request this, ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Klorn — the clear signal worth acting on
          </p>
        </div>
      `,
    });
    console.log("[EMAIL] Password reset email sent to", safeAddr);
    return true;
  } catch (err) {
    console.error("[EMAIL] Failed to send reset email:", err);
    return false;
  }
}

export async function sendWaitlistAdminAlert(entry: {
  email: string;
  name?: string | null;
  useCase?: string | null;
  isResubmission?: boolean;
}): Promise<boolean> {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const alertTo = process.env.WAITLIST_ALERT_EMAIL || adminEmails[0];
  if (!alertTo) {
    console.log(
      "[EMAIL] No waitlist alert target configured (ADMIN_EMAILS or WAITLIST_ALERT_EMAIL)",
    );
    return false;
  }

  if (!resend) {
    console.log(
      "[EMAIL] No RESEND_API_KEY — would alert",
      maskEmail(alertTo),
      "about",
      maskEmail(entry.email),
    );
    return true;
  }

  const safeEmail = entry.email.replace(/[<>]/g, "");
  const safeName = (entry.name || "").replace(/[<>]/g, "");
  const safeUseCase = (entry.useCase || "").replace(/[<>]/g, "");

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: alertTo,
      subject: entry.isResubmission
        ? `[Klorn] Waitlist re-submission: ${safeEmail}`
        : `[Klorn] New waitlist signup: ${safeEmail}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #d8a45d; margin: 0 0 16px;">${entry.isResubmission ? "Waitlist re-submission" : "New early-access request"}</h2>
          <p style="color: #374151; font-size: 14px; margin: 0 0 4px;"><strong>Email:</strong> ${safeEmail}</p>
          ${safeName ? `<p style="color: #374151; font-size: 14px; margin: 0 0 4px;"><strong>Name:</strong> ${safeName}</p>` : ""}
          ${safeUseCase ? `<p style="color: #374151; font-size: 14px; margin: 0 0 12px;"><strong>How they use email:</strong> ${safeUseCase}</p>` : ""}
          <p style="color: #6b7280; font-size: 13px; margin: 16px 0 0;">
            Review at <a href="${WEB_URL}/admin/waitlist">${WEB_URL}/admin/waitlist</a>.
          </p>
        </div>
      `,
    });
    console.log("[EMAIL] Waitlist alert sent for", maskEmail(entry.email));
    return true;
  } catch (err) {
    console.error("[EMAIL] Failed to send waitlist alert:", err);
    return false;
  }
}

export async function sendBetaInviteEmail(to: string, name?: string | null): Promise<boolean> {
  const loginUrl = `${WEB_URL}/login`;
  const safeAddr = maskEmail(to);
  const safeName = name?.trim()?.replace(/[<>]/g, "");
  const greeting = safeName ? `Hi ${safeName},` : "Hi,";

  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — invite link generated for", safeAddr);
    return true;
  }

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "You're approved — sign in to Klorn",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #d8a45d; margin-bottom: 24px;">You're approved</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            ${greeting}
          </p>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            I've added <strong style="color: #111827;">${to}</strong> to the Klorn test-user list in Google Cloud Console. Google's "Access blocked" screen should be gone for you now.
          </p>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            Open the login page below and click <strong>Continue with Google</strong> using this exact address. Klorn will start connecting your Gmail and Calendar into a single decision queue — every send, permanent delete, or external forward stops at an approval step with a verifiable receipt.
          </p>
          <a href="${loginUrl}" style="display: inline-block; background: #d8a45d; color: #10100d; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
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
    });
    console.log("[EMAIL] Beta invite email sent to", safeAddr);
    return true;
  } catch (err) {
    console.error("[EMAIL] Failed to send invite email:", err);
    return false;
  }
}

export async function sendVerificationEmail(to: string, verifyToken: string): Promise<boolean> {
  const verifyUrl = `${WEB_URL}/verify-email?token=${verifyToken}`;
  const safeAddr = maskEmail(to);

  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — verify link generated for", safeAddr);
    return true;
  }

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "Verify your Klorn account",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #d8a45d; margin-bottom: 24px;">Klorn</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            Welcome to Klorn! Please verify your email address to get started.
          </p>
          <a href="${verifyUrl}" style="display: inline-block; background: #d8a45d; color: #10100d; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Verify Email
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This link expires in 24 hours.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            Klorn — the clear signal worth acting on
          </p>
        </div>
      `,
    });
    console.log("[EMAIL] Verification email sent to", safeAddr);
    return true;
  } catch (err) {
    console.error("[EMAIL] Failed to send verification email:", err);
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
 * Outcome of a welcome-email attempt. `skipped` (Resend unconfigured) is kept
 * distinct from `failed` so the caller releases its once-per-user claim in
 * BOTH cases — a missing key must not permanently suppress the welcome — while
 * only `failed` is logged as an error.
 */
export type WelcomeSendResult = "sent" | "skipped" | "failed";

/** Send the founder welcome email via Resend. See WelcomeSendResult. */
export async function sendWelcomeEmail(
  to: string,
  name?: string | null,
): Promise<WelcomeSendResult> {
  const safeAddr = maskEmail(to);
  const founder = resolveFounder();
  const content = buildWelcomeEmail(to, name, founder);

  if (!resend) {
    console.warn("[EMAIL] No RESEND_API_KEY — welcome email skipped for", safeAddr);
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
    await resend.emails.send({
      from,
      to,
      replyTo,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    console.log("[EMAIL] Welcome email sent to", safeAddr);
    return "sent";
  } catch (err) {
    // Log + capture the REAL Resend error here so Sentry gets the actual cause
    // and stack, not a synthetic one reconstructed by the caller.
    console.error("[EMAIL] Failed to send welcome email:", err);
    captureError(err, { tags: { scope: "email.welcome-send" } });
    return "failed";
  }
}
