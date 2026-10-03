"use client";

import type { AuthProviderId, AuthProvidersResponse } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import ProviderButtons from "../../components/auth/provider-buttons";
import AuthScreen from "../../components/auth-screen";
import { useToast } from "../../components/toast";
import { Input } from "../../components/ui/input";
import { apiFetch } from "../../lib/api";
import { captureFirstTouchAttribution } from "../../lib/attribution";
import { useAuth } from "../../lib/auth";
import { readCachedProviders, writeCachedProviders } from "../../lib/auth-providers-cache";
import { useT } from "../../lib/i18n";
import { startNativeGoogleLogin } from "../../lib/native/native-auth";
import { isNativeShell } from "../../lib/native/shell";

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
  const { t } = useT();
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
    if (!isNativeShell()) return;
    e.preventDefault();
    startNativeGoogleLogin().catch((err) => {
      console.error("[AUTH] Native Google login failed:", err);
      toast(t("auth.googleSignInError"), "error");
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

  // Server-advertised sign-in providers (GET /api/auth/providers). Google
  // renders unconditionally inside ProviderButtons — it must never be held
  // hostage to this probe; Apple/Naver appear only when the deployment
  // enables them. Hidden in the native shell: those providers block WebView
  // OAuth like Google does, and the external-browser relay speaks Google only.
  const providersQuery = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: async () => {
      const res = await apiFetch<AuthProvidersResponse>("/api/auth/providers");
      writeCachedProviders(res);
      return res;
    },
    // Seeded from the last visit so the lane renders at its true height on
    // first paint instead of expanding once the probe lands.
    initialData: () => readCachedProviders()?.value,
    // Required, not optional: without the seed's real age react-query treats it
    // as fetched just-now on every mount, so the query never goes stale and
    // never refetches — the seed then outlives any server-side change to the
    // provider list. Passing the timestamp makes a seed older than staleTime
    // refetch immediately, which is the whole point of keeping one.
    initialDataUpdatedAt: () => readCachedProviders()?.at,
    staleTime: 5 * 60_000,
  });
  const [nativeShell, setNativeShell] = useState(false);
  useEffect(() => {
    setNativeShell(isNativeShell());
  }, []);

  // First-touch inflow capture. This used to live on /early-access; once
  // sign-up opened, nobody had a reason to go there, so every direct signup
  // reported nothing. The login page is the one surface both lanes cross.
  useEffect(() => {
    captureFirstTouchAttribution();
  }, []);
  const extraProviders: AuthProviderId[] = nativeShell
    ? []
    : (providersQuery.data?.providers ?? [])
        .map((p) => p.id)
        .filter((id): id is AuthProviderId => id === "apple" || id === "naver");
  // Reveal as soon as we have an answer — the seeded cache counts, so a
  // repeat visitor never sees the lane grow.
  const providersResolved = !nativeShell && providersQuery.data !== undefined;

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
          ? t("auth.googleSignInError")
          : error === "google_denied"
            ? t("auth.googleDenied")
            : error === "google_unverified"
              ? t("auth.googleUnverified")
              : error === "session_expired"
                ? t("auth.sessionExpired")
                : error === "invite_only"
                  ? t("auth.inviteOnlyRedirect")
                  : (socialErrorMessage(error, t) ?? error);
      toast(message, "error");
    }
    if (verified) {
      toast(t("auth.emailVerified"), "success");
    }
  }, [searchParams, toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setPasswordError(null);
    if (!email || !password) return;

    if (mode === "register" && password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(t("auth.passwordMinChars", { count: String(MIN_PASSWORD_LENGTH) }));
      return;
    }

    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password, nextPath);
        toast(t("auth.welcomeBack"), "success");
      } else {
        await register(email, password, name || undefined, nextPath);
        toast(t("auth.accountCreated"), "success");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("auth.genericError");
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
    } finally {
      // Reset on EVERY path. The register branch previously `return`ed before
      // this reset, leaving the submit button stuck spinning "Creating
      // account..." whenever the post-register redirect didn't immediately
      // unmount the form (e.g. auth state not yet populated).
      setLoading(false);
    }
  };

  return (
    <AuthScreen
      eyebrow={mode === "login" ? t("auth.welcomeBack") : t("auth.signUp")}
      title={mode === "login" ? t("auth.titleLogin") : t("auth.titleRegister")}
      description={mode === "login" ? t("auth.descLogin") : t("auth.descRegister")}
      footer={
        <div className="space-y-3">
          {/* Doctrine / scope copy is context ABOUT the product, not part of
              signing in — it sits under the card instead of inside it so the
              panel stays one task. Desktop only: on a phone the card already
              fills the viewport. */}
          <div className="hidden space-y-2 leading-5 md:block">
            <p>{t("auth.betaScope")}</p>
            <p>{t("auth.noSilentActions")}</p>
          </div>
          <p>
            <a
              href="https://github.com/k08200/klorn/blob/main/docs/doctrine/deterministic-floor.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-line-strong underline-offset-2 transition duration-300 ease-fluid hover:text-accent-deep hover:decoration-accent-muted"
            >
              {t("auth.readDoctrine")}
            </a>
            <span className="ml-2">{t("auth.openSourceVersion")}</span>
          </p>
          <Link
            href="/"
            className="inline-block transition duration-300 ease-fluid hover:text-ink-soft"
          >
            {t("auth.backHome")}
          </Link>
        </div>
      }
    >
      {nextPath !== "/inbox" && (
        <div className="mb-4 rounded-lg border border-notice-border bg-notice-bg px-3.5 py-2.5 text-xs leading-5 text-notice-ink">
          {t("auth.signInToContinue", { destination: returnDestinationLabel(nextPath, t) })}
        </div>
      )}

      {/* Invite-only cohort: request access is the action almost every visitor
          needs, so it leads. Social sign-in 403s for the un-invited, so it
          drops to a clearly-labelled secondary path. When the beta gate is
          off — the normal production state — the provider lane leads. */}
      {!signupOpen && (
        <div className="mb-5 space-y-4">
          <div
            data-testid="access-notice"
            className="rounded-lg border border-notice-border bg-notice-bg px-3.5 py-3 text-xs leading-5 text-notice-ink"
          >
            <span className="font-semibold text-notice-ink-strong">
              {t("auth.inviteOnlyTitle")}
            </span>{" "}
            {t("auth.inviteOnlyBody")}
          </div>

          <Link
            href="/early-access"
            className="flex h-12 w-full items-center justify-center rounded-lg bg-accent-solid text-sm font-semibold text-accent-solid-ink shadow-sm transition duration-300 ease-fluid hover:bg-accent-solid-hover active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 focus-ring"
          >
            {t("auth.requestEarlyAccess")}
          </Link>

          <p className="text-center text-xs text-ink-mid">{t("auth.alreadyApproved")}</p>
        </div>
      )}

      <section aria-label={t("auth.providerLaneLabel")}>
        <ProviderButtons
          extraProviders={extraProviders}
          resolved={providersResolved}
          onGoogleClick={handleGoogleClick}
        />
      </section>

      <div className="my-5 flex items-center gap-3">
        <div className="h-px flex-1 bg-line" />
        <span className="text-xs text-ink-mid">
          {signupOpen ? t("auth.orContinueEmail") : t("auth.orSignInEmail")}
        </span>
        <div className="h-px flex-1 bg-line" />
      </div>

      {signupOpen && (
        <div
          role="group"
          aria-label={t("auth.formGroupLabel")}
          className="mb-5 grid grid-cols-2 rounded-lg border border-line bg-surface-raised p-1"
        >
          <button
            type="button"
            aria-pressed={mode === "login"}
            onClick={() => changeMode("login")}
            className={`h-10 rounded-md px-3 text-sm font-medium transition duration-300 ease-fluid focus-ring ${
              mode === "login"
                ? "bg-surface-panel text-ink shadow-sm dark:bg-surface-hover"
                : "text-ink-mid hover:text-ink"
            }`}
          >
            {t("nav.logIn")}
          </button>
          <button
            type="button"
            aria-pressed={mode === "register"}
            onClick={() => changeMode("register")}
            className={`h-10 rounded-md px-3 text-sm font-medium transition duration-300 ease-fluid focus-ring ${
              mode === "register"
                ? "bg-surface-panel text-ink shadow-sm dark:bg-surface-hover"
                : "text-ink-mid hover:text-ink"
            }`}
          >
            {t("auth.signUpShort")}
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === "register" && (
          <Input
            ref={nameRef}
            id="name"
            label={t("auth.name")}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("auth.name")}
          />
        )}

        <Input
          ref={emailRef}
          id="email"
          label={t("auth.email")}
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
            <label htmlFor="password" className="block text-xs font-medium text-ink-mid">
              {t("auth.password")}
            </label>
            {mode === "login" && (
              <Link
                href="/reset-password"
                className="inline-flex min-h-10 items-center text-xs text-ink-mid transition duration-300 ease-fluid hover:text-accent-deeper"
              >
                {t("auth.resetPassword")}
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
            placeholder={mode === "register" ? t("auth.passwordMin") : t("auth.password")}
            required
            minLength={mode === "register" ? MIN_PASSWORD_LENGTH : undefined}
            error={passwordError ?? undefined}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !email || !password}
          aria-busy={loading}
          className="flex h-12 w-full items-center justify-center rounded-lg bg-accent-solid text-sm font-semibold text-accent-solid-ink shadow-sm transition duration-300 ease-fluid hover:bg-accent-solid-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-ink-mid disabled:shadow-none disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100 focus-ring"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              {/* currentColor, not a pinned slate — the ring inverts with the
                  filled accent when the theme swaps. */}
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {mode === "login" ? t("auth.signingIn") : t("auth.creatingAccount")}
            </span>
          ) : mode === "login" ? (
            t("auth.openDecisionQueue")
          ) : (
            t("auth.signUp")
          )}
        </button>
      </form>

      <div className="mt-5 border-t border-line pt-4 text-center text-xs text-ink-mid">
        {signupOpen ? (
          <>
            {mode === "login" ? t("auth.needAccount") : t("auth.haveAccount")}{" "}
            <button
              type="button"
              onClick={() => changeMode(mode === "login" ? "register" : "login")}
              className="inline-flex min-h-10 items-center font-medium text-accent-deeper underline-offset-2 transition duration-300 ease-fluid hover:underline focus-ring"
            >
              {mode === "login" ? t("auth.switchToSignUp") : t("auth.switchToLogIn")}
            </button>
          </>
        ) : (
          // Invite request already leads above; here we only help invited users
          // who lost their password, so we point at reset rather than repeat the
          // access CTA a third time.
          <>
            {t("auth.approvedCantSignIn")}{" "}
            <Link
              href="/reset-password"
              className="inline-flex min-h-10 items-center font-medium text-accent-deeper underline-offset-2 transition duration-300 ease-fluid hover:underline"
            >
              {t("auth.resetYourPassword")}
            </Link>
          </>
        )}
      </div>
    </AuthScreen>
  );
}

/**
 * Apple/Naver callback errors (`<provider>_<reason>` from the API's social
 * routes). null = not a social error; the caller shows the raw code.
 */
function socialErrorMessage(error: string, t: (key: string) => string): string | null {
  const match =
    /^(?:apple|naver)_(denied|failed|config|exchange|token|claims|email_in_use|email_unverified)$/.exec(
      error,
    );
  if (!match) return null;
  switch (match[1]) {
    case "denied":
      return t("auth.socialDenied");
    case "email_in_use":
      return t("auth.socialEmailInUse");
    case "email_unverified":
      return t("auth.socialEmailUnverified");
    // The deployment's provider credentials are wrong or half-set. Retrying
    // cannot fix that, so say so instead of inviting a pointless second try.
    case "config":
      return t("auth.socialNotConfigured");
    // A valid sign-in that carried no email. The visitor CAN fix this by
    // choosing to share an address, which is worth telling them.
    case "claims":
      return t("auth.socialNoEmail");
    default:
      return t("auth.socialSignInError");
  }
}

function safeNextPath(value: string | null): string {
  if (!value) return "/inbox";
  if (!value.startsWith("/") || value.startsWith("//")) return "/inbox";
  if (value.startsWith("/login")) return "/inbox";
  return value;
}

function returnDestinationLabel(path: string, t: (key: string) => string): string {
  const cleanPath = path.split("?")[0] || path;
  if (cleanPath === "/inbox") return t("nav.decisionQueue");
  if (cleanPath === "/email" || cleanPath.startsWith("/email/")) return t("nav.mail");
  if (cleanPath === "/calendar") return t("nav.calendar");
  if (cleanPath === "/briefing") return t("nav.briefing");
  if (cleanPath.startsWith("/settings/memory")) return t("auth.destMemory");
  if (cleanPath.startsWith("/settings/usage")) return t("auth.destUsage");
  if (cleanPath.startsWith("/settings/status")) return t("auth.destStatus");
  if (cleanPath.startsWith("/settings/email-feedback")) return t("auth.destFeedback");
  if (cleanPath === "/settings" || cleanPath.startsWith("/settings/")) return t("settings.title");
  if (cleanPath === "/billing") return t("nav.billing");
  if (cleanPath === "/files") return t("auth.destFiles");
  if (cleanPath === "/admin" || cleanPath.startsWith("/admin/")) return t("nav.admin");
  return path;
}
