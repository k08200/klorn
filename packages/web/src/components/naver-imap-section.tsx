"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import Button from "./ui/button";
import { Input } from "./ui/input";
import StatusChip from "./ui/status-chip";

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
  const { confirm } = useConfirm();
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
    const ok = await confirm({
      title: "Disconnect Naver mail?",
      message: "Existing classified emails stay. You can reconnect the mailbox any time.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
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
    <section className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-5">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Naver Mail</h2>
          <p className="mt-1 text-xs text-slate-500">
            Connect a Naver mailbox via IMAP. Klorn classifies every incoming message into the same
            4-tier firewall as Gmail.
          </p>
        </div>
        {status?.connected && <StatusChip status="connected" />}
      </header>

      {loading ? (
        <div className="text-xs text-slate-400">Loading…</div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-sm text-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{status.email}</p>
                <p className="text-[11px] text-slate-400">
                  Host: {status.host} · since{" "}
                  {status.connectedAt ? new Date(status.connectedAt).toLocaleString("en-US") : "—"}
                </p>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleDisconnect()}
                disabled={submitting}
                className="shrink-0"
              >
                Disconnect
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
      ) : !entitled ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4">
          <p className="text-sm text-slate-900">
            Connecting a second inbox is a <span className="font-semibold text-sky-600">Pro</span>{" "}
            feature.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Free covers your primary Google account. Upgrade in the Subscription section to run the
            firewall across a Naver mailbox too.
          </p>
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-3">
          <Input
            id="naver-email"
            label="Naver email"
            type="email"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@naver.com"
            required
            autoComplete="off"
          />
          <div>
            <Input
              id="naver-password"
              label="App password (외부 메일 가져오기 비밀번호)"
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="generated in Naver security settings"
              required
              autoComplete="off"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              This is NOT your Naver account password. Generate one at{" "}
              <a
                href={PASSWORD_HELP_URL}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-slate-700"
              >
                Naver Help → 외부 메일 비밀번호
              </a>
              . We store it encrypted (AES-GCM), never the plaintext.
            </p>
          </div>
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">Advanced: IMAP host</summary>
            <div className="mt-2">
              <Input
                aria-label="IMAP host"
                type="text"
                value={hostInput}
                onChange={(e) => setHostInput(e.target.value)}
                placeholder={DEFAULT_HOST}
              />
            </div>
          </details>
          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-600"
            >
              {error}
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || !emailInput || !passwordInput}
            loading={submitting}
          >
            Connect Naver Mail
          </Button>
        </form>
      )}
    </section>
  );
}
