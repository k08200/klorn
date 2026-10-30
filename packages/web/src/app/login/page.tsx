"use client";

import type { AuthProvidersResponse } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import LanePreview from "../../components/auth/lane-preview";
import ProviderButtons from "../../components/auth/provider-buttons";
import AuthScreen, { BrandHeadline } from "../../components/auth-screen";
import { useToast } from "../../components/toast";
import Button from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { apiFetch } from "../../lib/api";
import { captureFirstTouchAttribution } from "../../lib/attribution";
import { useAuth } from "../../lib/auth";
import { readCachedProviders, writeCachedProviders } from "../../lib/auth-providers-cache";
import { homePath } from "../../lib/home";
import { useT } from "../../lib/i18n";
import { startNativeGoogleLogin } from "../../lib/native/native-auth";
import { isNativeShell } from "../../lib/native/shell";
import { providerLane } from "../../lib/provider-lane";
import { loginNextPath } from "../../lib/safe-path";

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
  // Strict same-origin path (lib/safe-path.ts): "/\evil.com" or "/<tab>/evil.com"
  // would otherwise resolve to another host after sign-in.
  const nextPath = loginNextPath(searchParams.get("next"));
  // Whether the visitor was sent here from a page they should return to.
  const hasNext = searchParams.get("next") !== null;

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
  // The desktop poll sign-in's pairing code, shown while the browser asks the
  // person to confirm against it (api auth/desktop-confirm.ts).
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const handleGoogleClick = (e: React.MouseEvent) => {
    if (!isNativeShell()) return;
    e.preventDefault();
    startNativeGoogleLogin(setPairingCode)
      .catch((err) => {
        console.error("[AUTH] Native Google login failed:", err);
        toast(t("auth.googleSignInError"), "error");
      })
      .finally(() => setPairingCode(null));
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
  // null until mount: see providerLane — the first client render must match
  // the server's, which cannot know this or read the provider cache.
  const [nativeShell, setNativeShell] = useState<boolean | null>(null);
  useEffect(() => {
    setNativeShell(isNativeShell());
  }, []);

  // First-touch inflow capture. This used to live on /early-access; once
  // sign-up opened, nobody had a reason to go there, so every direct signup
  // reported nothing. The login page is the one surface both lanes cross.
  useEffect(() => {
    captureFirstTouchAttribution();
  }, []);
  // Reveal as soon as we have an answer after mount — the seeded cache
  // counts, so a repeat visitor sees the lane open at hydration instead of
  // after the probe.
  const { extras: extraProviders, resolved: providersResolved } = providerLane(
    nativeShell,
    providersQuery.data,
  );

  useEffect(() => {
    if (!authLoading && user) {
      // No `next`: the user's home, which is Today under UNIFIED_HOME.
      router.push(hasNext ? nextPath : homePath(user));
    }
  }, [user, authLoading, hasNext, nextPath, router]);

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
        await login(email, password, hasNext ? nextPath : undefined);
        toast(t("auth.welcomeBack"), "success");
      } else {
        await register(email, password, name || undefined, hasNext ? nextPath : undefined);
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
    <AuthScreen title={<BrandHeadline />} description={t("auth.subline")} preview={<LanePreview />}>
      {nextPath !== "/inbox" && (
        <p className="mb-6 rounded-card border border-notice-border bg-notice-bg px-3.5 py-2.5 text-label text-notice-ink">
          {t("auth.signInToContinue", { destination: returnDestinationLabel(nextPath, t) })}
        </p>
      )}

      {/* Invite-only cohort: request access is the action almost every visitor
          needs, so it leads. Social sign-in 403s for the un-invited, so it
          drops to a clearly-labelled secondary path. When the beta gate is
          off — the normal production state — the provider lane leads. */}
      {!signupOpen && (
        <div className="mb-6 space-y-3">
          <div
            data-testid="access-notice"
            className="rounded-card border border-notice-border bg-notice-bg px-3.5 py-3 text-label text-notice-ink"
          >
            <span className="font-semibold text-notice-ink-strong">
              {t("auth.inviteOnlyTitle")}
            </span>{" "}
            {t("auth.inviteOnlyBody")}
          </div>

          <Link
            href="/early-access"
            className="focus-ring flex h-11 w-full items-center justify-center rounded-control bg-accent-solid text-label text-accent-solid-ink transition-colors duration-120 ease-fluid hover:bg-accent-solid-hover"
          >
            {t("auth.requestEarlyAccess")}
          </Link>

          <p className="text-center text-caption text-ink-mid">{t("auth.alreadyApproved")}</p>
        </div>
      )}

      <h2 className="mb-4 text-head text-ink">
        {mode === "login" ? t("auth.formTitleLogin") : t("auth.formTitleRegister")}
      </h2>

      <section aria-label={t("auth.providerLaneLabel")}>
        <ProviderButtons
          extraProviders={extraProviders}
          resolved={providersResolved}
          onGoogleClick={handleGoogleClick}
        />
        {pairingCode && (
          <p role="status" className="mt-3 text-label text-ink-mid">
            {t("auth.desktopPairingCode", { code: pairingCode })}
          </p>
        )}
      </section>

      <div className="my-5 flex items-center gap-3" aria-hidden="true">
        <div className="h-px flex-1 bg-line" />
        <span className="text-caption text-ink-mid">
          {signupOpen ? t("auth.orContinueEmail") : t("auth.orSignInEmail")}
        </span>
        <div className="h-px flex-1 bg-line" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" aria-label={t("auth.formGroupLabel")}>
        {mode === "register" && (
          <Input
            ref={nameRef}
            id="name"
            label={t("auth.name")}
            type="text"
            autoComplete="name"
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
          autoComplete="email"
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
                className="focus-ring -my-3 inline-flex min-h-11 items-center rounded-control text-caption text-ink-mid transition-colors duration-120 ease-fluid hover:text-accent-deep"
              >
                {t("auth.resetPassword")}
              </Link>
            )}
          </div>
          <Input
            id="password"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
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

        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={loading}
          disabled={!email || !password}
          aria-busy={loading}
        >
          {loading
            ? mode === "login"
              ? t("auth.signingIn")
              : t("auth.creatingAccount")
            : mode === "login"
              ? t("auth.signIn")
              : t("auth.signUp")}
        </Button>
      </form>

      <LegalConsent />

      <p className="mt-6 flex flex-wrap items-center justify-center gap-x-1 text-label text-ink-mid">
        {signupOpen ? (
          <>
            <span>{mode === "login" ? t("auth.needAccount") : t("auth.haveAccount")}</span>
            <Button
              variant="link"
              onClick={() => changeMode(mode === "login" ? "register" : "login")}
            >
              {mode === "login" ? t("auth.switchToSignUp") : t("auth.switchToLogIn")}
            </Button>
          </>
        ) : (
          // Invite request already leads above; here we only help invited users
          // who lost their password, so we point at reset rather than repeat the
          // access CTA a third time.
          <>
            <span>{t("auth.approvedCantSignIn")}</span>
            <Link
              href="/reset-password"
              className="focus-ring inline-flex min-h-11 items-center rounded-control px-1 text-accent-deep underline-offset-2 hover:underline"
            >
              {t("auth.resetYourPassword")}
            </Link>
          </>
        )}
      </p>
    </AuthScreen>
  );
}

/**
 * The consent line, directly under the sign-in/sign-up action it refers to.
 *
 * AuthScreen's footer already links /privacy and /terms, but a pair of nav
 * links at the bottom of the chrome is not the same thing as telling someone
 * what they are agreeing to at the moment they agree to it — which is what
 * both sign-in paths here (Google and email) actually do.
 *
 * One template with two placeholders rather than three concatenated fragments:
 * the clause order differs across the seven languages Klorn ships, and
 * splitting on the tokens lets each locale put the links where its own grammar
 * wants them. The order is resolved from the string instead of assumed, so a
 * locale that names the privacy policy first still renders correctly.
 */
function LegalConsent() {
  const { t } = useT();
  const linkClass =
    "focus-ring rounded-control text-ink underline decoration-line-strong underline-offset-2 transition-colors duration-120 ease-fluid hover:text-accent-deep";
  // Split on the first occurrence of each token only, keeping ALL the text
  // around them. A plain `split` would silently drop everything after a
  // repeated token, and the i18n parity guard counts keys, not the
  // placeholders inside them, so a hand-edited translation can produce any of
  // these shapes. Order is read from the string rather than assumed, and a
  // token that never appeared leaves its slot empty instead of printing
  // "{privacy}" verbatim.
  const template = t("auth.legalConsent");
  const termsAt = template.indexOf("{terms}");
  const privacyAt = template.indexOf("{privacy}");
  const termsFirst = termsAt <= privacyAt;
  const first = termsFirst ? "{terms}" : "{privacy}";
  const second = termsFirst ? "{privacy}" : "{terms}";
  const firstAt = template.indexOf(first);
  const rest = firstAt < 0 ? "" : template.slice(firstAt + first.length);
  const secondAt = rest.indexOf(second);
  const lead = firstAt < 0 ? template : template.slice(0, firstAt);
  const middle = secondAt < 0 ? rest : rest.slice(0, secondAt);
  const tail = secondAt < 0 ? "" : rest.slice(secondAt + second.length);
  // Any token that survived (a duplicate, or the pair being absent) is stripped
  // so no brace ever reaches the user.
  const text = (part: string) => part.replace(/\{(?:terms|privacy)\}/g, "");

  const termsLink = (
    <Link href="/terms" className={linkClass}>
      {t("auth.legalConsentTerms")}
    </Link>
  );
  const privacyLink = (
    <Link href="/privacy" className={linkClass}>
      {t("auth.legalConsentPrivacy")}
    </Link>
  );

  return (
    <p className="mt-5 text-center text-caption text-ink-mid">
      {text(lead)}
      {termsFirst ? termsLink : privacyLink}
      {text(middle)}
      {termsFirst ? privacyLink : termsLink}
      {text(tail)}
    </p>
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

function returnDestinationLabel(path: string, t: (key: string) => string): string {
  const cleanPath = path.split("?")[0] || path;
  // "/inbox" is Approvals with UNIFIED_HOME on and the legacy page with it off;
  // new copy names it Approvals either way (docs/product-vocabulary.md).
  if (cleanPath === "/inbox") return t("nav.v2.approvals");
  if (cleanPath === "/today") return t("nav.v2.today");
  if (cleanPath === "/assistant" || cleanPath.startsWith("/assistant/")) return t("nav.assistant");
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
