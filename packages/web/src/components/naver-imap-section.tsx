"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { captureClientError } from "../lib/sentry";

interface NaverImapStatus {
  connected: boolean;
  email: string | null;
  host: string | null;
  connectedAt: string | null;
}

interface ConnectResponse {
  ok: boolean;
  email?: string;
  host?: string;
  message?: string;
}

const DEFAULT_HOST = "imap.naver.com:993";

const PASSWORD_HELP_URL = "https://help.naver.com/service/3007/contents/?lang=ko";

export function NaverImapSection() {
  const { user } = useAuth();
  // Multi-account (a second inbox) is a paid feature. `entitled` is server-
  // computed and always true while the paywall is off, so this gate is inert
  // pre-launch. An already-connected mailbox stays visible so a user who
  // downgraded can still see and disconnect it.
  const entitled = user?.entitled !== false;
  const [status, setStatus] = useState<NaverImapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [hostInput, setHostInput] = useState(DEFAULT_HOST);
  const [submitting, setSubmitting] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<NaverImapStatus>("/api/naver-imap/status");
      setStatus(data);
    } catch (err) {
      captureClientError(err, { scope: "naver-imap.status" });
      setError("Could not load Naver connection status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<ConnectResponse>("/api/naver-imap/connect", {
        method: "POST",
        body: JSON.stringify({
          email: emailInput.trim(),
          password: passwordInput,
          host: hostInput.trim() || DEFAULT_HOST,
        }),
      });
      if (!data.ok) {
        setError(data.message || "Connection failed.");
      } else {
        setEmailInput("");
        setPasswordInput("");
        await loadStatus();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      captureClientError(err, { scope: "naver-imap.connect" });
      setError(msg || "Connection failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    if (submitting) return;
    if (!confirm("Disconnect Naver mail? Existing classified emails stay.")) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/naver-imap/disconnect", { method: "POST" });
      await loadStatus();
    } catch (err) {
      captureClientError(err, { scope: "naver-imap.disconnect" });
      setError("Disconnect failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-xl border border-stone-800 bg-stone-950/40 p-5">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-100">Naver Mail</h2>
          <p className="mt-1 text-xs text-stone-400">
            Connect a Naver mailbox via IMAP. Klorn classifies every incoming message into the same
            4-tier firewall as Gmail.
          </p>
        </div>
        {status?.connected && (
          <span className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-1 text-[11px] font-medium text-emerald-300">
            Connected
          </span>
        )}
      </header>

      {loading ? (
        <div className="text-xs text-stone-500">Loading…</div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="rounded-md border border-stone-800 bg-stone-900/40 p-3 text-sm text-stone-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{status.email}</p>
                <p className="text-[11px] text-stone-500">
                  Host: {status.host} · since{" "}
                  {status.connectedAt ? new Date(status.connectedAt).toLocaleString() : "—"}
                </p>
              </div>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={submitting}
                className="rounded-md border border-stone-700 px-3 py-1.5 text-xs text-stone-300 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      ) : !entitled ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm text-stone-200">
            Connecting a second inbox is a <span className="font-semibold text-amber-300">Pro</span>{" "}
            feature.
          </p>
          <p className="mt-1 text-xs text-stone-400">
            Free covers your primary Google account. Upgrade in the Subscription section to run the
            firewall across a Naver mailbox too.
          </p>
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-3">
          <div>
            <label htmlFor="naver-email" className="mb-1 block text-xs text-stone-400">
              Naver email
            </label>
            <input
              id="naver-email"
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="you@naver.com"
              required
              autoComplete="off"
              className="w-full rounded-md border border-stone-700 bg-stone-900/60 px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500/60 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="naver-password" className="mb-1 block text-xs text-stone-400">
              App password (외부 메일 가져오기 비밀번호)
            </label>
            <input
              id="naver-password"
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="generated in Naver security settings"
              required
              autoComplete="off"
              className="w-full rounded-md border border-stone-700 bg-stone-900/60 px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500/60 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-stone-500">
              This is NOT your Naver account password. Generate one at{" "}
              <a
                href={PASSWORD_HELP_URL}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-stone-300"
              >
                Naver Help → 외부 메일 비밀번호
              </a>
              . We store it encrypted (AES-GCM), never the plaintext.
            </p>
          </div>
          <details className="text-xs text-stone-500">
            <summary className="cursor-pointer">Advanced: IMAP host</summary>
            <input
              type="text"
              value={hostInput}
              onChange={(e) => setHostInput(e.target.value)}
              placeholder={DEFAULT_HOST}
              className="mt-2 w-full rounded-md border border-stone-800 bg-stone-900/40 px-3 py-1.5 text-xs text-stone-300 focus:border-amber-500/60 focus:outline-none"
            />
          </details>
          {error && (
            <div className="rounded-md border border-red-700/40 bg-red-950/30 p-3 text-xs text-red-300">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting || !emailInput || !passwordInput}
            className="rounded-md border border-amber-500/60 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Verifying…" : "Connect Naver Mail"}
          </button>
        </form>
      )}
    </section>
  );
}
