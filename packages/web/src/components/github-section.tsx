"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import { useToast } from "./toast";

interface GitHubStatus {
  connected: boolean;
  connectedAt: string | null;
  lastPolledAt?: string | null;
}

// POST /api/github/connect returns { ok, login? } on success and
// { ok: false, message } with a 400 on a bad token. apiFetch throws
// `API <status>: <json body>` for the 400, so parse the message out of it.
function parseConnectError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : "";
  const match = msg.match(/API \d+: (.+)/);
  if (!match) return fallback;
  try {
    // The connect route uses `message`; tolerate `error` too for safety.
    const body = JSON.parse(match[1]);
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

// Pre-scoped classic PAT page: notifications scope, named "Klorn".
const NEW_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=notifications&description=Klorn";

export function GitHubSection() {
  const [connected, setConnected] = useState(false);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const loadStatus = useCallback(async () => {
    try {
      const data = await apiFetch<GitHubStatus>("/api/github/status");
      setConnected(data.connected);
      setConnectedAt(data.connectedAt);
    } catch (err) {
      captureClientError(err, { scope: "github.status" });
      setError("Could not load GitHub connection status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const connect = async () => {
    if (submitting || !token.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch<{ ok: boolean; login?: string }>("/api/github/connect", {
        method: "POST",
        body: JSON.stringify({ token: token.trim() }),
      });
      // Never keep the PAT around once it is saved server-side.
      setToken("");
      setConnected(true);
      await loadStatus();
      toast("GitHub connected.", "success");
    } catch (err) {
      captureClientError(err, { scope: "github.connect" });
      setError(parseConnectError(err, "Could not connect GitHub."));
    } finally {
      setSubmitting(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: "Disconnect GitHub",
      message:
        "Klorn stops turning your GitHub notifications into firewall items. You can reconnect any time.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/github/disconnect", { method: "POST" });
      setConnected(false);
      setConnectedAt(null);
      toast("GitHub disconnected.", "info");
    } catch (err) {
      captureClientError(err, { scope: "github.disconnect" });
      setError("Could not disconnect GitHub.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 bg-stone-950/35 border border-stone-700/45 rounded-xl p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium">GitHub</h3>
          <p className="text-sm text-stone-400">
            {connected
              ? "Connected — PR reviews, mentions, and CI failures become firewall items."
              : "Turn GitHub notifications into firewall items."}
          </p>
        </div>
        {loading ? (
          <span className="text-sm text-stone-500">Loading...</span>
        ) : connected ? (
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-sm text-green-400 flex items-center gap-1">
              <span className="w-2 h-2 bg-green-400 rounded-full" />
              Connected
            </span>
            <button
              type="button"
              onClick={disconnect}
              disabled={submitting}
              className="text-xs text-stone-500 hover:text-red-400 transition disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>

      {connected && connectedAt && (
        <p className="mt-2 text-xs text-stone-500">
          Connected since {new Date(connectedAt).toLocaleString()}.
        </p>
      )}

      {!connected && !loading && (
        <div className="mt-3 space-y-2 rounded-lg border border-stone-800 bg-stone-900/40 p-3">
          <p className="text-sm text-stone-300">
            Connect a GitHub personal access token (classic) with the{" "}
            <span className="font-mono text-stone-200">notifications</span> scope — add{" "}
            <span className="font-mono text-stone-200">repo</span> for private repos. PR reviews,
            mentions, and CI failures become firewall items.
          </p>
          <p className="text-xs text-stone-500">
            <a
              href={NEW_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="text-amber-300 underline hover:text-amber-200"
            >
              Create a pre-scoped token
            </a>{" "}
            on GitHub, then paste it below.
          </p>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_..."
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-stone-700 bg-stone-900/60 px-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:border-amber-500/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={connect}
            disabled={submitting || !token.trim()}
            className="rounded-md bg-amber-300 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Verifying..." : "Connect"}
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
