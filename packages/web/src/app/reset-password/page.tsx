"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AuthScreen from "../../components/auth-screen";
import { Input } from "../../components/ui/input";
import { apiFetch } from "../../lib/api";

// Signup enforces 8; reset must not be weaker — unify to the stronger policy.
const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  // Without a token, show the reset-link request form.
  if (!token) {
    return <ForgotPasswordForm />;
  }

  return <NewPasswordForm token={token} />;
}

function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setEmailError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      // Inline field error is the single announcement (WCAG 4.1.3) — it is
      // rendered role="alert", so no duplicate error toast.
      setEmailError("Could not send the reset link. Check the address and try again.");
    }
    setLoading(false);
  };

  if (sent) {
    return (
      <AuthScreen
        eyebrow="Password reset"
        title="Check your email"
        description="If that email account exists, we sent a password reset link."
        footer={
          <Link href="/login" className="transition hover:text-slate-900">
            Back to login
          </Link>
        }
      >
        <div className="border-y border-slate-200 py-5 text-sm leading-6 text-slate-500">
          The link is only valid for a limited time. Check spam if it does not appear.
        </div>
        <Link
          href="/login"
          className="mt-5 flex h-11 w-full items-center justify-center rounded-md bg-sky-500 text-sm font-semibold text-white transition hover:bg-sky-600"
        >
          Open login
        </Link>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      eyebrow="Password reset"
      title="Reset password"
      description="Enter your account email and we will send a secure reset link."
      footer={
        <Link href="/login" className="transition hover:text-slate-900">
          Back to login
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => {
            if (emailError) setEmailError(null);
            setEmail(e.target.value);
          }}
          placeholder="you@example.com"
          required
          error={emailError ?? undefined}
        />

        <button
          type="submit"
          disabled={loading || !email}
          className="flex h-11 w-full items-center justify-center rounded-md bg-sky-500 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {loading ? "Sending..." : "Send reset link"}
        </button>
      </form>
    </AuthScreen>
  );
}

function NewPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setConfirmError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      // Field-level validation: inline error is the single announcement
      // (WCAG 4.1.3, rendered role="alert") — no duplicate error toast.
      setConfirmError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await apiFetch("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword: password }),
      });
      setDone(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Reset failed.";
      // Inline field error is the single announcement (WCAG 4.1.3) — no toast.
      setPasswordError(message);
    }
    setLoading(false);
  };

  if (done) {
    return (
      <AuthScreen
        eyebrow="Password updated"
        title="Password reset complete"
        description="Your password was changed. You can now log in with the new password."
      >
        <Link
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-sky-500 text-sm font-semibold text-white transition hover:bg-sky-600"
        >
          Log in
        </Link>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      eyebrow="New password"
      title="Set a new password"
      description="Enter the password you will use for your next login."
      footer={
        <Link href="/login" className="transition hover:text-slate-900">
          Back to login
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          id="password"
          label="New password"
          type="password"
          value={password}
          onChange={(e) => {
            if (passwordError) setPasswordError(null);
            setPassword(e.target.value);
          }}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          required
          minLength={MIN_PASSWORD_LENGTH}
          error={passwordError ?? undefined}
        />

        <Input
          id="confirm"
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(e) => {
            if (confirmError) setConfirmError(null);
            setConfirm(e.target.value);
          }}
          placeholder="Re-enter password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          error={confirmError ?? undefined}
        />

        <button
          type="submit"
          disabled={loading || !password || !confirm}
          className="flex h-11 w-full items-center justify-center rounded-md bg-sky-500 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {loading ? "Resetting..." : "Reset password"}
        </button>
      </form>
    </AuthScreen>
  );
}
