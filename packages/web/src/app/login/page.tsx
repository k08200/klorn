"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import AuthScreen from "../../components/auth-screen";
import { useToast } from "../../components/toast";
import { Input } from "../../components/ui/input";
import { API_BASE, apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { isNativePlatform } from "../../lib/native/capacitor";
import { startNativeGoogleLogin } from "../../lib/native/native-auth";

const MIN_PASSWORD_LENGTH = 8;

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  // Honor ?mode=register so external CTAs (landing "Get started", DM links)
  // can land directly on the sign-up tab instead of the default login tab.
  const initialMode: "login" | "register" =
    searchParams.get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const { login, register, user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const nextPath = safeNextPath(searchParams.get("next"));

  // First field of the form — focus moves here when the mode toggles so
  // keyboard/AT users are not stranded after the fields swap.
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  // Skip the very first render so we don't steal focus on initial mount.
  const modeMounted = useRef(false);

  const changeMode = (next: "login" | "register") => {
    setEmailError(null);
    setPasswordError(null);
    setMode(next);
  };

  useEffect(() => {
    if (!modeMounted.current) {
      modeMounted.current = true;
      return;
    }
    const first = mode === "register" ? nameRef.current : emailRef.current;
    first?.focus();
  }, [mode]);

  // In the native shell, Google blocks OAuth inside the WebView, so intercept
  // the link and run the system-browser flow instead. On the web the <a href>
  // navigates normally (no-op here).
  const handleGoogleClick = (e: React.MouseEvent) => {
    if (!isNativePlatform()) return;
    e.preventDefault();
    startNativeGoogleLogin().catch((err) => {
      console.error("[AUTH] Native Google login failed:", err);
      toast("Google sign-in could not be completed. Please try again.", "error");
    });
  };

  // Server controls whether sign-up is open. When BETA_GATE_ENABLED is on,
  // hide the Sign-up tab and point new visitors at /early-access. Until the
  // probe resolves we assume open so existing users with the gate off see
  // no flash; signupOpen flips to false the moment the response arrives.
  const signupStatus = useQuery({
    queryKey: ["auth", "signup-status"],
    queryFn: () => apiFetch<{ open: boolean }>("/api/auth/signup-status"),
    staleTime: 5 * 60_000,
  });
  const signupOpen = signupStatus.data?.open ?? true;
  useEffect(() => {
    if (!signupOpen && mode === "register") setMode("login");
  }, [signupOpen, mode]);

  useEffect(() => {
    if (!authLoading && user) {
      router.push(nextPath);
    }
  }, [user, authLoading, nextPath, router]);

  // Surface redirect feedback from Google OAuth and email verification.
  useEffect(() => {
    const error = searchParams.get("error");
    const verified = searchParams.get("verified");
    if (error) {
      const message =
        error === "google_failed"
          ? "Google sign-in could not be completed. Please try again."
          : error === "session_expired"
            ? "Your session expired. Please sign in again."
            : error === "invite_only"
              ? "Klorn is invite-only right now. Request access from the early access page."
              : error;
      toast(message, "error");
    }
    if (verified) {
      toast("Email verified. You can sign in now.", "success");
    }
  }, [searchParams, toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setPasswordError(null);
    if (!email || !password) return;

    if (mode === "register" && password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password, nextPath);
        toast("Welcome back.", "success");
      } else {
        await register(email, password, name || undefined, nextPath);
        toast("Account created.", "success");
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      const match = msg.match(/API \d+: (.+)/);
      const parsed = match
        ? (() => {
            try {
              return JSON.parse(match[1]).error;
            } catch {
              return match[1];
            }
          })()
        : msg;
      // Inline field error is the single announcement (WCAG 4.1.3) — the
      // message is attached to a field and rendered role="alert", so we do NOT
      // also fire a toast with the same text (that would announce it twice).
      // "Email already registered" (409 on register) is about the EMAIL field,
      // so route duplicate-email messages there first; only the ambiguous login
      // 401 ("Invalid email or password") lands on the password field.
      const isDuplicateEmail = /already (registered|exists|in use)|duplicate|taken/i.test(parsed);
      const isCredential = /password|credential|invalid|account/i.test(parsed);
      if (isDuplicateEmail) {
        setEmailError(parsed);
      } else if (isCredential) {
        setPasswordError(parsed);
      } else {
        setEmailError(parsed);
      }
    }
    setLoading(false);
  };

  return (
    <AuthScreen
      eyebrow={mode === "login" ? "Welcome back" : "Create account"}
      title={mode === "login" ? "Return to your decision queue" : "Start with Klorn"}
      description={
        mode === "login"
          ? "Reconnect your work signals and continue where you left off."
          : "Connect Gmail and Calendar to turn team signals into evidence-backed decision cards."
      }
      footer={
        <Link href="/" className="transition hover:text-stone-300">
          Back to home
        </Link>
      }
    >
      {nextPath !== "/inbox" && (
        <div className="mb-4 rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100">
          Sign in to continue to{" "}
          <span className="font-medium text-amber-50">{returnDestinationLabel(nextPath)}</span>.
        </div>
      )}

      {/* Invite-only cohort: request access is the action almost every visitor
          needs, so it leads. Google sign-in 403s for the un-invited, so it drops
          to a clearly-labelled secondary path. One gate message replaces the old
          three-way callouts. When the beta gate is off, Google leads as before. */}
      {!signupOpen ? (
        <div className="space-y-4">
          <div className="rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-2.5 text-xs leading-5 text-amber-100">
            <span className="font-semibold text-amber-50">Klorn is invite-only.</span> Google blocks
            sign-in until your email is approved as a test user. Request access first — you can sign
            in the moment you&apos;re approved.
          </div>

          <Link
            href="/early-access"
            className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 shadow-sm shadow-amber-300/20 transition hover:bg-amber-200"
          >
            Request early access
          </Link>

          <a
            href={`${API_BASE}/api/auth/google/login`}
            onClick={handleGoogleClick}
            className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-stone-700 bg-transparent text-sm font-medium text-stone-300 transition hover:border-stone-500 hover:text-stone-100"
          >
            <GoogleMark />
            Already approved? Sign in with Google
          </a>
        </div>
      ) : (
        <>
          <a
            href={`${API_BASE}/api/auth/google/login`}
            onClick={handleGoogleClick}
            className="flex h-11 w-full items-center justify-center gap-3 rounded-md bg-stone-100 text-sm font-semibold text-stone-900 shadow-sm transition hover:bg-white"
          >
            <GoogleMark />
            Continue with Google
          </a>
          {/* Marketing/doctrine copy is landing-page context — hide it on the app
              (mobile) for a clean login; keep it on desktop. */}
          <div className="mt-3 hidden space-y-2 text-center text-[11px] leading-5 text-stone-400 md:block">
            <p>
              Free during the private beta. Google flags unverified apps with the restricted Gmail
              scope until CASA review clears — standard for every Gmail integration.
            </p>
            <p>
              What we don’t do: send mail without a click-through receipt. Every send, permanent
              delete, and external forward is hash-bound and verifiable on read.
            </p>
            <p>
              <a
                href="https://github.com/k08200/klorn/blob/main/docs/doctrine/deterministic-floor.md"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-stone-600 underline-offset-2 hover:text-amber-200 hover:decoration-amber-300"
              >
                Read the doctrine before the login flow →
              </a>
              <span className="ml-2 text-stone-500">Open source · AGPLv3 · v0.3.0</span>
            </p>
          </div>
        </>
      )}

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-stone-800/80" />
        <span className="text-xs text-stone-400">
          {signupOpen ? "or continue with email" : "or sign in with email"}
        </span>
        <div className="h-px flex-1 bg-stone-800/80" />
      </div>

      {signupOpen && (
        <div
          role="group"
          aria-label="Sign in or create an account"
          className="mb-5 grid grid-cols-2 rounded-md border border-stone-700/70 bg-black/20 p-1"
        >
          <button
            type="button"
            aria-pressed={mode === "login"}
            onClick={() => changeMode("login")}
            className={`h-11 rounded px-3 text-sm font-medium transition ${
              mode === "login"
                ? "bg-stone-100 text-stone-950"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Log in
          </button>
          <button
            type="button"
            aria-pressed={mode === "register"}
            onClick={() => changeMode("register")}
            className={`h-11 rounded px-3 text-sm font-medium transition ${
              mode === "register"
                ? "bg-stone-100 text-stone-950"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            Sign up
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === "register" && (
          <Input
            ref={nameRef}
            id="name"
            label="Name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
          />
        )}

        <Input
          ref={emailRef}
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

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label htmlFor="password" className="block text-xs font-medium text-stone-400">
              Password
            </label>
            {mode === "login" && (
              <Link
                href="/reset-password"
                className="inline-flex min-h-10 items-center text-xs text-stone-400 transition hover:text-amber-300"
              >
                Reset password
              </Link>
            )}
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              if (passwordError) setPasswordError(null);
              setPassword(e.target.value);
            }}
            placeholder={mode === "register" ? "At least 8 characters" : "Password"}
            required
            minLength={mode === "register" ? MIN_PASSWORD_LENGTH : undefined}
            error={passwordError ?? undefined}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !email || !password}
          className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 shadow-sm shadow-amber-300/20 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-stone-950 border-t-transparent" />
              {mode === "login" ? "Signing in..." : "Creating account..."}
            </span>
          ) : mode === "login" ? (
            "Open decision queue"
          ) : (
            "Create account"
          )}
        </button>
      </form>

      <div className="mt-5 border-t border-stone-800/80 pt-4 text-center text-xs text-stone-500">
        {signupOpen ? (
          <>
            {mode === "login" ? "Need an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => changeMode(mode === "login" ? "register" : "login")}
              className="inline-flex min-h-10 items-center font-medium text-amber-300 transition hover:text-amber-200"
            >
              {mode === "login" ? "Switch to sign-up" : "Switch to log-in"}
            </button>
          </>
        ) : (
          // Invite request already leads above; here we only help invited users
          // who lost their password, so we point at reset rather than repeat the
          // access CTA a third time.
          <>
            Approved but can&apos;t sign in?{" "}
            <Link
              href="/reset-password"
              className="inline-flex min-h-10 items-center font-medium text-amber-300 transition hover:text-amber-200"
            >
              Reset your password
            </Link>
          </>
        )}
      </div>
    </AuthScreen>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function safeNextPath(value: string | null): string {
  if (!value) return "/inbox";
  if (!value.startsWith("/") || value.startsWith("//")) return "/inbox";
  if (value.startsWith("/login")) return "/inbox";
  return value;
}

function returnDestinationLabel(path: string): string {
  const cleanPath = path.split("?")[0] || path;
  if (cleanPath === "/inbox") return "Decision queue";
  if (cleanPath === "/email" || cleanPath.startsWith("/email/")) return "Mail";
  if (cleanPath === "/calendar") return "Calendar";
  if (cleanPath === "/briefing") return "Briefing";
  if (cleanPath === "/settings") return "Settings";
  if (cleanPath.startsWith("/settings/memory")) return "Memory settings";
  if (cleanPath.startsWith("/settings/usage")) return "Usage settings";
  if (cleanPath.startsWith("/settings/status")) return "System status";
  if (cleanPath.startsWith("/settings/email-feedback")) return "Mail feedback";
  if (cleanPath === "/billing") return "Plan and billing";
  if (cleanPath === "/files") return "Files";
  if (cleanPath === "/admin" || cleanPath.startsWith("/admin/")) return "Admin";
  return path;
}
