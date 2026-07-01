import { Resend } from "resend";
import { captureError } from "./sentry.js";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || "EVE <onboarding@resend.dev>";
const WEB_URL = process.env.WEB_URL || "http://localhost:8001";

/** Mask email for safe logging: "user@example.com" → "u***@example.com" */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return email[0] + "***" + email.slice(at);
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

/** Who the welcome email is signed from. An empty `name` drops to a neutral team voice. */
export interface FounderIdentity {
  /** Founder first name, e.g. "Ada". Empty string → team voice, no title line. */
  name: string;
  /** Title under the sign-off, e.g. "Founder". Only rendered when `name` is set. */
  title: string;
  /** Community link; when null the "come say hi" line is omitted entirely. */
  communityUrl: string | null;
}

const FOUNDER: FounderIdentity = {
  name: (process.env.FOUNDER_NAME || "").trim(),
  title: (process.env.FOUNDER_TITLE || "Founder").trim(),
  communityUrl: process.env.COMMUNITY_URL?.trim() || null,
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Greeting name: the first token of the display name, else the email's local part. */
function greetingName(email: string, name: string | null): string {
  const trimmed = (name ?? "").trim();
  if (trimmed) return trimmed.split(/\s+/)[0];
  const local = email.split("@")[0];
  return local || "there";
}

export interface WelcomeEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Build the founder welcome email. Pure (no I/O) so it is unit-testable and
 * reusable by any send path. The recipient name is the only untrusted input, so
 * it is HTML-escaped everywhere it reaches the markup.
 */
export function buildWelcomeEmail(
  email: string,
  name: string | null,
  founder: FounderIdentity = FOUNDER,
): WelcomeEmailContent {
  const subject = "Welcome to Klorn";
  const first = greetingName(email, name);
  const hasFounder = founder.name.trim().length > 0;

  const intro = hasFounder
    ? `I'm ${founder.name}, and I build Klorn.`
    : "I'm on the team that builds Klorn.";
  const signoff = hasFounder ? `— ${founder.name}\n${founder.title}, Klorn` : "— The Klorn team";
  const pitch =
    "Klorn is your email firewall — it reads every incoming message, decides what actually deserves your attention, and quietly handles the noise. What's left is the clear signal worth acting on.";
  const learn =
    'Give it a day or two to learn your patterns. Tell it "less" or "more" on any decision and the tiers adjust to you.';
  const reply = "Just reply to this email if you hit any friction — it comes straight to me.";

  const textLines = [`Hey ${first},`, "", intro, "", pitch, "", learn, "", reply];
  if (founder.communityUrl) textLines.push("", `Come say hi: ${founder.communityUrl}`);
  textLines.push("", signoff);
  const text = textLines.join("\n");

  const p = (inner: string) =>
    `<p style="color:#374151;font-size:16px;line-height:1.6;">${inner}</p>`;
  const communityHtml = founder.communityUrl
    ? `<p style="color:#6b7280;font-size:14px;line-height:1.6;">Come say hi: <a href="${escapeHtml(
        founder.communityUrl,
      )}" style="color:#d8a45d;">${escapeHtml(founder.communityUrl)}</a></p>`
    : "";
  const signoffHtml = hasFounder
    ? `— ${escapeHtml(founder.name)}<br/>${escapeHtml(founder.title)}, Klorn`
    : "— The Klorn team";
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #d8a45d; margin-bottom: 24px;">Welcome to Klorn</h2>
      ${p(`Hey ${escapeHtml(first)},`)}
      ${p(escapeHtml(intro))}
      ${p(pitch)}
      ${p(learn)}
      ${p(reply)}
      ${communityHtml}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
      <p style="color:#9ca3af;font-size:14px;line-height:1.6;">${signoffHtml}</p>
    </div>
  `;

  return { subject, text, html };
}

/**
 * Send the welcome email via Resend. Returns a tri-state so the caller can tell a
 * real failure ("failed", already logged + captured here) from a graceful no-op
 * ("skipped", Resend unconfigured) and release/keep its idempotency claim
 * accordingly. Never throws.
 */
export async function sendWelcomeEmail(
  to: string,
  name?: string | null,
): Promise<"sent" | "skipped" | "failed"> {
  const safeAddr = maskEmail(to);
  const { subject, text, html } = buildWelcomeEmail(to, name ?? null);

  if (!resend) {
    console.log("[EMAIL] No RESEND_API_KEY — welcome email skipped for", safeAddr);
    return "skipped";
  }

  try {
    await resend.emails.send({ from: FROM_EMAIL, to, subject, text, html });
    console.log("[EMAIL] Welcome email sent to", safeAddr);
    return "sent";
  } catch (err) {
    console.error("[EMAIL] Failed to send welcome email to", safeAddr, err);
    captureError(err, { tags: { scope: "welcome-email.send" }, extra: { to: safeAddr } });
    return "failed";
  }
}
