import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || "EVE <noreply@hireeve.com>";
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
      subject: "Reset your EVE password",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #3b82f6; margin-bottom: 24px;">EVE</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            You requested a password reset. Click the button below to set a new password.
          </p>
          <a href="${resetUrl}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Reset Password
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This link expires in 1 hour. If you didn't request this, ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            EVE — Your First AI Employee
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
      subject: `[EVE] New waitlist signup: ${safeEmail}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #3b82f6; margin: 0 0 16px;">New early-access request</h2>
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
      subject: "Verify your EVE account",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #3b82f6; margin-bottom: 24px;">EVE</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.6;">
            Welcome to EVE! Please verify your email address to get started.
          </p>
          <a href="${verifyUrl}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Verify Email
          </a>
          <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
            This link expires in 24 hours.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            EVE — Your First AI Employee
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
