/**
 * Welcome (Welcome artboard) + email sign-in and sign-up. Google and Apple go
 * through the system browser and the server's desktop relay (auth/oauth.ts);
 * the Apple button appears only when the API lists it (GET
 * /api/auth/providers). Email sign-up (POST /api/auth/register) makes the app
 * usable without a third-party login; while the server keeps sign-up
 * invite-only (BETA_GATE_ENABLED, GET /api/auth/signup-status) the form says
 * so up front and shows the server's refusal as it is.
 */
import { type FormEvent, useEffect, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { useAuthProviders } from "../../api/queries";
import { getServices } from "../../app/services";
import { OAuthError, type SocialProvider, startSocialLogin } from "../../auth/oauth";
import { useSession } from "../../auth/session";
import { isLocale, LOCALE_NAMES, LOCALES, type MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { openExternal } from "../../platform/external";
import { Icon } from "../../ui/Icon";
import { notify } from "../../ui/StatusNote";
import "./welcome.css";

const TERMS_URL = "https://klorn.ai/terms/";
const PRIVACY_URL = "https://klorn.ai/privacy/";
/** The waitlist the server's invite-only refusal points to (routes/auth.ts "/early-access"). */
const EARLY_ACCESS_URL = "https://app.klorn.ai/early-access";
const MIN_PASSWORD = 8;

type FormError = { key: MessageKey; values?: Record<string, string> };

/** POST /api/auth/register refusals, as the server words them (routes/auth.ts). */
function registerError(err: unknown): FormError {
  if (isApiError(err)) {
    if (err.isOffline) return { key: "login.error.network" };
    if (err.status === 403) return { key: "register.error.inviteOnly" };
    if (err.status === 409) return { key: "register.error.exists" };
    if (err.status === 429) return { key: "login.error.rateLimited" };
    if (err.status === 400 && err.serverMessage) {
      return /8 characters/i.test(err.serverMessage)
        ? { key: "register.error.password" }
        : { key: "register.error.server", values: { message: err.serverMessage } };
    }
  }
  return { key: "login.error.generic" };
}

function errorKey(err: unknown): MessageKey {
  if (err instanceof OAuthError)
    return err.reason === "timeout" ? "login.error.timeout" : "login.error.generic";
  if (isApiError(err)) {
    if (err.isOffline) return "login.error.network";
    if (err.status === 401) return "login.error.invalid";
    if (err.status === 429) return "login.error.rateLimited";
  }
  return "login.error.generic";
}

function LanguagePicker() {
  const { t, locale, setOverride } = useI18n();
  return (
    <label className="welcome__language">
      <Icon name="globe" size={16} />
      <span aria-hidden="true">{LOCALE_NAMES[locale]}</span>
      <select
        aria-label={t("welcome.language", { name: LOCALE_NAMES[locale] })}
        value={locale}
        onChange={(e) => setOverride(isLocale(e.target.value) ? e.target.value : null)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

function Legal() {
  const { t } = useI18n();
  const template = t("welcome.legal");
  const parts = template.split(/(\{terms\}|\{privacy\})/);
  return (
    <p className="welcome__legal">
      {parts.map((part, i) => {
        const key = `${i}-${part}`;
        if (part === "{terms}" || part === "{privacy}") {
          const isTerms = part === "{terms}";
          return (
            <a
              key={key}
              href={isTerms ? TERMS_URL : PRIVACY_URL}
              onClick={(e) => {
                e.preventDefault();
                void openExternal(isTerms ? TERMS_URL : PRIVACY_URL);
              }}
            >
              {t(isTerms ? "welcome.terms" : "welcome.privacy")}
            </a>
          );
        }
        return <span key={key}>{part}</span>;
      })}
    </p>
  );
}

/**
 * The accounts production can connect (the landing's list): Gmail, a company
 * Google Workspace, and Naver / iCloud in beta. Never a provider that is dark
 * in production (Outlook) — App Store 2.3 accurate metadata.
 */
const CHIPS = [
  { l: "G", color: "var(--source-gmail)", name: "Gmail", x: 8, y: 8, r: -4 },
  { l: "W", color: "var(--source-work)", name: "Workspace", x: 176, y: 0, r: 3 },
  { l: "N", color: "var(--source-naver)", name: "NAVER", x: 0, y: 66, r: 2 },
  { l: "i", color: "var(--source-icloud)", name: "iCloud", x: 200, y: 58, r: -2 },
];

function Illustration() {
  const { t } = useI18n();
  return (
    <div className="welcome__art" aria-hidden="true">
      {CHIPS.map((c) => (
        <span
          key={c.l}
          className="welcome__chip"
          style={{ left: `${(c.x / 350) * 100}%`, top: c.y, transform: `rotate(${c.r}deg)` }}
        >
          <span className="welcome__chip-mark" style={{ background: c.color }}>
            {c.l}
          </span>
          {c.name}
        </span>
      ))}
      <div className="welcome__card">
        <span className="welcome__card-label">{t("welcome.card.label")}</span>
        <span className="welcome__card-chips">
          <span className="lane-chip lane-chip--brief lane-chip--push">PUSH 2</span>
          <span className="lane-chip lane-chip--brief lane-chip--meeting">MEETING 3</span>
        </span>
        <span className="welcome__card-line">{t("welcome.card.line")}</span>
      </div>
    </div>
  );
}

function EmailForm({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { signIn } = useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [inviteOnly, setInviteOnly] = useState(false);
  const register = mode === "register";

  useEffect(() => {
    if (!register) return;
    let alive = true;
    // Best effort: an older server without the probe just shows no notice.
    getServices()
      .ep.auth.signupStatus()
      .then((res) => {
        if (alive) setInviteOnly(res.open === false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [register]);

  const switchMode = () => {
    setMode(register ? "login" : "register");
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (register && password.length < MIN_PASSWORD) {
      setError({ key: "register.error.password" });
      return;
    }
    setBusy(true);
    setError(null);
    const address = email.trim();
    try {
      const { ep } = getServices();
      const { token } = register
        ? await ep.auth.register(address, password, name.trim() || undefined)
        : await ep.auth.login(address, password);
      await signIn(token);
      if (register) notify(t("register.done", { email: address }));
    } catch (err) {
      setError(register ? registerError(err) : { key: errorKey(err) });
      setBusy(false);
    }
  };

  const openEarlyAccess = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    void openExternal(EARLY_ACCESS_URL);
  };
  const refusedInvite = error?.key === "register.error.inviteOnly";

  return (
    <form className="welcome__form" onSubmit={(e) => void submit(e)} noValidate>
      <button type="button" className="welcome__back" onClick={onBack}>
        <Icon name="chevronLeft" size={22} strokeWidth={2.2} />
        {t("login.back")}
      </button>
      <h1 className="welcome__form-title">{t(register ? "register.title" : "login.title")}</h1>
      {register && inviteOnly && !refusedInvite ? (
        <p className="welcome__notice" role="status">
          {t("register.inviteOnly")}{" "}
          <a href={EARLY_ACCESS_URL} onClick={openEarlyAccess}>
            {t("register.requestAccess")}
          </a>
        </p>
      ) : null}
      {register ? (
        <label className="field">
          <span className="field__label">{t("register.name")}</span>
          <input
            type="text"
            autoComplete="name"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      ) : null}
      <label className="field">
        <span className="field__label">{t("login.email")}</span>
        <input
          type="email"
          inputMode="email"
          autoComplete={register ? "email" : "username"}
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={320}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">{t("login.password")}</span>
        <input
          type="password"
          autoComplete={register ? "new-password" : "current-password"}
          required
          minLength={register ? MIN_PASSWORD : undefined}
          maxLength={200}
          aria-describedby={register ? "register-password-hint" : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {register ? (
          <span id="register-password-hint" className="field__hint">
            {t("register.passwordHint")}
          </span>
        ) : null}
      </label>
      {error ? (
        <p className="welcome__error" role="alert">
          {t(error.key, error.values)}
          {refusedInvite ? (
            <>
              {" "}
              <a href={EARLY_ACCESS_URL} onClick={openEarlyAccess}>
                {t("register.requestAccess")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <button
        type="submit"
        className="button button--primary welcome__submit"
        disabled={busy || !email.trim() || !password}
      >
        {t(register ? "register.submit" : "login.submit")}
      </button>
      {register ? null : (
        <a
          className="welcome__forgot"
          href="https://app.klorn.ai/reset-password"
          onClick={(e) => {
            e.preventDefault();
            void openExternal("https://app.klorn.ai/reset-password");
          }}
        >
          {t("login.forgot")}
        </a>
      )}
      <button type="button" className="welcome__switch" onClick={switchMode}>
        {t(register ? "login.toLogin" : "login.toRegister")}
      </button>
    </form>
  );
}

export function WelcomeScreen() {
  const { t } = useI18n();
  const { signIn, endedReason } = useSession();
  const providers = useAuthProviders();
  const [mode, setMode] = useState<"choose" | "email">("choose");
  const [waiting, setWaiting] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const abort = useRef<AbortController | null>(null);

  const appleEnabled = providers.data?.providers.some((p) => p.id === "apple") ?? false;

  const social = async (provider: SocialProvider) => {
    setError(null);
    setWaiting(provider);
    abort.current = new AbortController();
    try {
      const token = await startSocialLogin(provider, getServices().ep, abort.current.signal);
      await signIn(token);
    } catch (err) {
      if (!(err instanceof OAuthError && err.reason === "cancelled")) setError(errorKey(err));
    } finally {
      setWaiting(null);
    }
  };

  return (
    <main className="welcome">
      <div className="welcome__bar">
        <span className="brand">
          <span className="brand__mark welcome__mark" aria-hidden="true">
            K
          </span>
          <span className="brand__name">{t("app.name")}</span>
        </span>
        <LanguagePicker />
      </div>

      {mode === "email" ? (
        <EmailForm onBack={() => setMode("choose")} />
      ) : (
        <>
          <Illustration />
          <div className="welcome__copy">
            <h1 className="welcome__headline">
              {t("welcome.headline.before")}
              <br />
              <em className="welcome__em">{t("welcome.headline.em")}</em>{" "}
              {t("welcome.headline.after")}
            </h1>
            <p className="welcome__body">{t("welcome.body")}</p>
          </div>
          <div className="welcome__actions" aria-busy={providers.isPending || undefined}>
            {endedReason ? (
              <p className="welcome__notice" role="status">
                {t(endedReason === "deleted" ? "settings.delete.done" : "session.expired")}
              </p>
            ) : null}
            {error ? (
              <p className="welcome__error" role="alert">
                {t(error)}
              </p>
            ) : null}
            {appleEnabled ? (
              <button
                type="button"
                className="welcome__button welcome__button--apple"
                disabled={waiting !== null}
                onClick={() => void social("apple")}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.8-1-2.8-4.2zM14 5.2c.7-.8 1.2-2 1-3.2-1 .1-2.2.7-3 1.5-.6.7-1.2 1.9-1 3.1 1.1.1 2.3-.6 3-1.4z" />
                </svg>
                {t("welcome.apple")}
              </button>
            ) : null}
            <button
              type="button"
              className="welcome__button welcome__button--google"
              disabled={waiting !== null}
              onClick={() => void social("google")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"
                />
                <path
                  fill="#34A853"
                  d="M12 22c2.7 0 5-.9 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"
                />
                <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z" />
                <path
                  fill="#EA4335"
                  d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z"
                />
              </svg>
              {t("welcome.google")}
            </button>
            <button
              type="button"
              className="welcome__button welcome__button--text"
              disabled={waiting !== null}
              onClick={() => setMode("email")}
            >
              {t("welcome.email")}
            </button>
            <Legal />
          </div>
        </>
      )}

      {waiting ? (
        <div className="welcome__waiting" role="status" aria-live="polite">
          <span>{t("login.waiting")}</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => abort.current?.abort()}
          >
            {t("login.cancel")}
          </button>
        </div>
      ) : null}
    </main>
  );
}
