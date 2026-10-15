"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AuthScreen from "../../components/auth-screen";
import Button from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";

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
  const { t } = useT();
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
      setEmailError(t("resetPassword.error.sendFailed"));
    }
    setLoading(false);
  };

  if (sent) {
    return (
      <AuthScreen
        title={t("resetPassword.checkEmail.title")}
        description={t("resetPassword.checkEmail.description")}
      >
        <p className="rounded-card border border-line bg-surface-raised px-4 py-3 text-body text-ink-mid">
          {t("resetPassword.checkEmail.body")}
        </p>
        <Link
          href="/login"
          className="mt-6 focus-ring flex h-11 w-full items-center justify-center rounded-control bg-accent-solid text-label text-accent-solid-ink transition-colors duration-120 ease-fluid hover:bg-accent-solid-hover"
        >
          {t("resetPassword.openLogin")}
        </Link>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen title={t("auth.resetPassword")} description={t("resetPassword.description")}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          id="email"
          label={t("auth.email")}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            if (emailError) setEmailError(null);
            setEmail(e.target.value);
          }}
          placeholder={t("resetPassword.emailPlaceholder")}
          required
          error={emailError ?? undefined}
        />

        <Button type="submit" size="lg" className="w-full" loading={loading} disabled={!email}>
          {loading ? t("resetPassword.sending") : t("resetPassword.sendLink")}
        </Button>
      </form>
      <BackToSignIn />
    </AuthScreen>
  );
}

function NewPasswordForm({ token }: { token: string }) {
  const { t } = useT();
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
      setPasswordError(t("auth.passwordMinChars", { count: String(MIN_PASSWORD_LENGTH) }));
      return;
    }
    if (password !== confirm) {
      // Field-level validation: inline error is the single announcement
      // (WCAG 4.1.3, rendered role="alert") — no duplicate error toast.
      setConfirmError(t("resetPassword.confirmPassword.mismatch"));
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
      const message = err instanceof Error ? err.message : t("resetPassword.error.genericFailed");
      // Inline field error is the single announcement (WCAG 4.1.3) — no toast.
      setPasswordError(message);
    }
    setLoading(false);
  };

  if (done) {
    return (
      <AuthScreen
        title={t("resetPassword.updated.title")}
        description={t("resetPassword.updated.description")}
      >
        <Link
          href="/login"
          className="focus-ring flex h-11 w-full items-center justify-center rounded-control bg-accent-solid text-label text-accent-solid-ink transition-colors duration-120 ease-fluid hover:bg-accent-solid-hover"
        >
          {t("auth.signIn")}
        </Link>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title={t("resetPassword.newPassword.title")}
      description={t("resetPassword.newPassword.description")}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          id="password"
          label={t("resetPassword.newPassword.label")}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            if (passwordError) setPasswordError(null);
            setPassword(e.target.value);
          }}
          placeholder={t("auth.passwordMin")}
          required
          minLength={MIN_PASSWORD_LENGTH}
          error={passwordError ?? undefined}
        />

        <Input
          id="confirm"
          label={t("resetPassword.confirmPassword.label")}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => {
            if (confirmError) setConfirmError(null);
            setConfirm(e.target.value);
          }}
          placeholder={t("resetPassword.confirmPassword.placeholder")}
          required
          minLength={MIN_PASSWORD_LENGTH}
          error={confirmError ?? undefined}
        />

        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={loading}
          disabled={!password || !confirm}
        >
          {loading ? t("resetPassword.resetting") : t("auth.resetPassword")}
        </Button>
      </form>
      <BackToSignIn />
    </AuthScreen>
  );
}

/** Quiet way back from either reset step; the form stays the only primary. */
function BackToSignIn() {
  const { t } = useT();
  return (
    <p className="mt-6 text-center">
      <Link
        href="/login"
        className="focus-ring inline-flex min-h-11 items-center rounded-control px-1 text-label text-accent-deep underline-offset-2 hover:underline"
      >
        {t("auth.backToLogin")}
      </Link>
    </p>
  );
}
