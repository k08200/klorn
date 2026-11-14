"use client";

// Settings → Integrations → Slack (docs/providers/slack.md §15). Shown only
// while the API's SLACK_ENABLED opens Slack to this user (/me user.slack).
// Setup: start (mints the Request URL), download the manifest, create and
// install the app in Slack, paste the signing secret and user token (the
// token is checked and not kept), retry verification in Slack. Read-only:
// Klorn never posts to Slack.

import { useCallback, useEffect, useId, useState } from "react";
import { useConfirm } from "../../../components/confirm-dialog";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import StatusChip from "../../../components/ui/status-chip";
import { API_BASE, apiFetch, authHeaders } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { PANEL } from "./shared";
import {
  parseChannelIds,
  type SlackConnectionStatus,
  slackFailure,
  slackPanelVisible,
  slackWorkspaceHost,
} from "./slack-settings";

const SLACK_APPS_URL = "https://api.slack.com/apps";

type Connected = Exclude<SlackConnectionStatus, { state: "none" }>;

function useSlackStatus(enabled: boolean) {
  const [status, setStatus] = useState<SlackConnectionStatus | null>(null);
  const reload = useCallback(async () => {
    setStatus(await apiFetch<SlackConnectionStatus>("/api/slack/connection"));
  }, []);
  useEffect(() => {
    if (enabled) reload().catch(() => setStatus({ state: "none" }));
  }, [enabled, reload]);
  return { status, setStatus, reload };
}

function SetupSteps({
  status,
  onSaved,
}: {
  status: Connected;
  onSaved: (s: SlackConnectionStatus) => void;
}) {
  const { t } = useT();
  const { toast } = useToast();
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const downloadManifest = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/slack/manifest`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => "")}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "klorn-slack-manifest.yaml";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const failure = slackFailure(err);
      toast(t(failure.key, failure.vars), "error");
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      const next = await apiFetch<SlackConnectionStatus>("/api/slack/connection/credentials", {
        method: "PUT",
        body: JSON.stringify({ signingSecret: secret, userToken: token }),
      });
      setSecret("");
      setToken("");
      onSaved(next);
      toast(t("slack.connected"), "success");
    } catch (err) {
      const failure = slackFailure(err);
      toast(t(failure.key, failure.vars), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ol className="list-decimal space-y-3 pl-5 text-role-body text-ink">
      <li>
        <p>{t("slack.step.manifest")}</p>
        {status.requestUrl ? (
          <p className="mt-1 break-all text-role-caption text-ink-mid">
            {t("slack.requestUrl")}: <code>{status.requestUrl}</code>
          </p>
        ) : (
          <p className="mt-1 text-role-caption text-ink-mid">
            {t("slack.error.public-url-missing")}
          </p>
        )}
        <Button
          variant="secondary"
          className="mt-2"
          onClick={downloadManifest}
          disabled={!status.requestUrl}
        >
          {t("slack.downloadManifest")}
        </Button>
      </li>
      <li>
        <p>{t("slack.step.create")}</p>
        <a
          href={SLACK_APPS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex min-h-11 items-center text-accent-deep underline"
        >
          {t("slack.openSlackApps")}
        </a>
      </li>
      <li className="space-y-2">
        <p>{t("slack.step.paste")}</p>
        <Input
          label={t("slack.signingSecret")}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <Input
          label={t("slack.userToken")}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button onClick={connect} loading={busy} disabled={!secret || !token}>
          {t("slack.connect")}
        </Button>
      </li>
      <li>
        <p>{t("slack.step.verify")}</p>
      </li>
    </ol>
  );
}

function ChannelOptIn({
  status,
  onSaved,
}: {
  status: Connected;
  onSaved: (s: SlackConnectionStatus) => void;
}) {
  const { t } = useT();
  const { toast } = useToast();
  const fieldId = useId();
  const [text, setText] = useState(status.optInChannelIds.join(", "));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const next = await apiFetch<SlackConnectionStatus>("/api/slack/connection/channels", {
        method: "PUT",
        body: JSON.stringify({ channelIds: parseChannelIds(text) }),
      });
      onSaved(next);
      toast(t("slack.channels.saved"), "success");
    } catch (err) {
      const failure = slackFailure(err);
      toast(t(failure.key, failure.vars), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={fieldId} className="block font-medium text-ink">
        {t("slack.channels.title")}
      </label>
      <p className="text-role-caption text-ink-mid">{t("slack.channels.desc")}</p>
      <textarea
        id={fieldId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="w-full rounded-control border border-line-strong bg-surface-raised px-3 py-2 text-role-body text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
      />
      <Button variant="secondary" onClick={save} loading={busy}>
        {t("slack.channels.save")}
      </Button>
    </div>
  );
}

function ConnectionLine({ status }: { status: Connected }) {
  const { t } = useT();
  const host = slackWorkspaceHost(status.workspaceUrl);
  if (status.state !== "connected") return null;
  return (
    <div className="space-y-1 text-role-body">
      <StatusChip
        status={status.lastEventAt ? "connected" : "pending"}
        label={host ? t("slack.status.connected", { workspace: host }) : t("slack.connected")}
      />
      <p className="text-role-caption text-ink-mid">
        {status.lastEventAt
          ? t("slack.status.lastEvent", { time: new Date(status.lastEventAt).toLocaleString() })
          : t("slack.status.waiting")}
      </p>
    </div>
  );
}

export function SlackPanel() {
  const { user } = useAuth();
  const { t } = useT();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const visible = slackPanelVisible(user);
  const { status, setStatus } = useSlackStatus(visible);
  const [busy, setBusy] = useState(false);

  if (!visible || status === null) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      const failure = slackFailure(err);
      toast(t(failure.key, failure.vars), "error");
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      setStatus(await apiFetch<SlackConnectionStatus>("/api/slack/connection", { method: "POST" }));
    });

  const disconnect = async () => {
    const ok = await confirm({
      title: t("slack.disconnect.title"),
      message: t("slack.disconnect.message"),
      confirmLabel: t("slack.disconnect"),
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      await apiFetch("/api/slack/connection", { method: "DELETE" });
      setStatus({ state: "none" });
      toast(t("slack.disconnected"), "success");
    });
  };

  return (
    <section className="mb-8">
      <div className={`${PANEL} space-y-4 p-4`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium">{t("slack.title")}</h3>
            <p className="text-role-body text-ink-mid">{t("slack.desc")}</p>
          </div>
          {status.state === "none" ? (
            <Button variant="secondary" onClick={start} loading={busy}>
              {t("slack.start")}
            </Button>
          ) : (
            <Button variant="secondary" onClick={disconnect} loading={busy}>
              {t("slack.disconnect")}
            </Button>
          )}
        </div>
        {status.state !== "none" && (
          <>
            <ConnectionLine status={status} />
            {status.state === "pending" ? (
              <SetupSteps status={status} onSaved={setStatus} />
            ) : (
              <details>
                <summary className="min-h-11 cursor-pointer py-2 text-role-body text-ink">
                  {t("slack.setupAgain")}
                </summary>
                <SetupSteps status={status} onSaved={setStatus} />
              </details>
            )}
            {status.state === "connected" && <ChannelOptIn status={status} onSaved={setStatus} />}
          </>
        )}
      </div>
    </section>
  );
}
