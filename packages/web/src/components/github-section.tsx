"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useConfirm } from "./confirm-dialog";
import { useToast } from "./toast";
import Button from "./ui/button";
import { Input } from "./ui/input";
import StatusChip from "./ui/status-chip";

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
    <div className="mt-4 bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-medium">GitHub</h3>
          <p className="text-sm text-slate-500">
            {connected
              ? "Connected — PR reviews, mentions, and CI failures become firewall items."
              : "Turn GitHub notifications into firewall items."}
          </p>
        </div>
        {loading ? (
          <span className="text-sm text-slate-500">Loading...</span>
        ) : connected ? (
          <div className="flex shrink-0 items-center gap-3">
            <StatusChip status="connected" />
            <Button
              variant="danger"
              size="sm"
              onClick={() => void disconnect()}
              disabled={submitting}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>

      {connected && connectedAt && (
        <p className="mt-2 text-xs text-slate-400">
          Connected since {new Date(connectedAt).toLocaleString("en-US")}.
        </p>
      )}

      {!connected && !loading && (
        <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm text-slate-500">
            Connect a GitHub personal access token (classic) with the{" "}
            <span className="font-mono text-slate-900">notifications</span> scope — add{" "}
            <span className="font-mono text-slate-900">repo</span> for private repos. PR reviews,
            mentions, and CI failures become firewall items.
          </p>
          <p className="text-xs text-slate-400">
            <a
              href={NEW_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sky-600 underline hover:text-sky-500"
            >
              Create a pre-scoped token
            </a>{" "}
            on GitHub, then paste it below.
          </p>
          <Input
            aria-label="GitHub personal access token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_..."
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            variant="primary"
            onClick={() => void connect()}
            disabled={submitting || !token.trim()}
            loading={submitting}
          >
            Connect
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
