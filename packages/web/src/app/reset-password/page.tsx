"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AuthScreen from "../../components/auth-screen";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";

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
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      toast("Could not send the reset link.", "error");
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
          <Link href="/login" className="transition hover:text-stone-300">
            Back to login
          </Link>
        }
      >
        <div className="border-y border-stone-800/80 py-5 text-sm leading-6 text-stone-300">
          The link is only valid for a limited time. Check spam if it does not appear.
        </div>
        <Link
          href="/login"
          className="mt-5 flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
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
        <Link href="/login" className="transition hover:text-stone-300">
          Back to login
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-stone-400">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !email}
          className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
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
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast("Passwords do not match.", "error");
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
      toast(err instanceof Error ? err.message : "Reset failed.", "error");
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
          className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
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
        <Link href="/login" className="transition hover:text-stone-300">
          Back to login
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-stone-400">
            New password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
            required
            minLength={6}
            className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
          />
        </div>

        <div>
          <label htmlFor="confirm" className="mb-1.5 block text-xs font-medium text-stone-400">
            Confirm password
          </label>
          <input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter password"
            required
            minLength={6}
            className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !password || !confirm}
          className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
        >
          {loading ? "Resetting..." : "Reset password"}
        </button>
      </form>
    </AuthScreen>
  );
}
