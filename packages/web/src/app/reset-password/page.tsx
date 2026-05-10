"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
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

  // If no token, show "request reset" form
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
      toast("Failed to send reset link", "error");
    }
    setLoading(false);
  };

  if (sent) {
    return (
      <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-xl font-bold mb-3">Check your email</h1>
          <p className="text-stone-400 text-sm mb-6">
            If an account with that email exists, we sent a password reset link.
          </p>
          <Link href="/login" className="text-sm text-amber-300 hover:text-amber-200">
            Back to login
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold">Reset Password</h1>
          <p className="text-stone-500 text-xs mt-1.5">Enter your email to receive a reset link</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="email" className="block text-xs font-medium text-stone-400 mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email}
            className="w-full bg-amber-300 hover:bg-amber-200 disabled:bg-stone-900 disabled:text-stone-500 disabled:cursor-not-allowed text-stone-950 py-2.5 rounded-lg text-sm font-semibold transition-colors"
          >
            {loading ? "Sending..." : "Send Reset Link"}
          </button>
        </form>

        <div className="text-center mt-4">
          <Link
            href="/login"
            className="text-xs text-stone-500 hover:text-amber-300 transition-colors"
          >
            Back to login
          </Link>
        </div>
      </div>
    </main>
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
      toast("Passwords do not match", "error");
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
      toast(err instanceof Error ? err.message : "Reset failed", "error");
    }
    setLoading(false);
  };

  if (done) {
    return (
      <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-xl font-bold mb-3">Password Reset</h1>
          <p className="text-stone-400 text-sm mb-6">Your password has been reset successfully.</p>
          <Link href="/login" className="text-sm text-amber-300 hover:text-amber-200">
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex items-center justify-center min-h-[calc(100vh-3rem)] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold">New Password</h1>
          <p className="text-stone-500 text-xs mt-1.5">Enter your new password</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="password" className="block text-xs font-medium text-stone-400 mb-1.5">
              New Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              minLength={6}
              className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
            />
          </div>

          <div>
            <label htmlFor="confirm" className="block text-xs font-medium text-stone-400 mb-1.5">
              Confirm Password
            </label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat password"
              required
              minLength={6}
              className="w-full bg-stone-950 border border-stone-800 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25 transition placeholder-stone-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !password || !confirm}
            className="w-full bg-amber-300 hover:bg-amber-200 disabled:bg-stone-900 disabled:text-stone-500 disabled:cursor-not-allowed text-stone-950 py-2.5 rounded-lg text-sm font-semibold transition-colors"
          >
            {loading ? "Resetting..." : "Reset Password"}
          </button>
        </form>
      </div>
    </main>
  );
}
