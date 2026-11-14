"use client";

import type { OrgInvitePreviewResponse } from "@klorn/contract";
import Link from "next/link";
import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { PAGE_SHELL } from "../../components/page-shell";
import Button from "../../components/ui/button";
import Switch from "../../components/ui/switch";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { captureClientError } from "../../lib/sentry";
import {
  apiErrorCode,
  INVITE_TOKEN_STORAGE_KEY,
  inviteTokenFromHash,
  isInviteToken,
  orgErrorKey,
  TERMINAL_INVITE_CODES,
} from "../settings/_sections/org/model";
import { jsonBody, useOrgAction } from "../settings/_sections/org/use-org";
import { PRIMARY_BTN } from "../settings/_sections/shared";

/**
 * Accepting a Klorn Teams invite. The token arrives in the URL fragment (never
 * sent to a server); it is moved to sessionStorage and the fragment cleared
 * before the sign-in redirect could drop it, then posted in a request body.
 */
function captureToken(): string | null {
  const fromHash = inviteTokenFromHash(window.location.hash);
  if (fromHash) {
    try {
      window.sessionStorage.setItem(INVITE_TOKEN_STORAGE_KEY, fromHash);
    } catch {
      // Storage blocked: the token lives in this page only.
    } finally {
      // The fragment goes either way: it must not stay in the address bar or history.
      window.history.replaceState(null, "", window.location.pathname);
    }
    return fromHash;
  }
  try {
    const stored = window.sessionStorage.getItem(INVITE_TOKEN_STORAGE_KEY);
    return isInviteToken(stored) ? stored : null;
  } catch {
    return null;
  }
}

function forgetToken() {
  try {
    window.sessionStorage.removeItem(INVITE_TOKEN_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; key: string }
  | { kind: "ready"; preview: OrgInvitePreviewResponse }
  | { kind: "joined"; orgName: string };

function InviteAccept({ token }: { token: string | null }) {
  const { t } = useT();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [share, setShare] = useState(false);
  const { busy, errorKey, run } = useOrgAction();

  useEffect(() => {
    if (!user) return;
    // Nothing is asked of a server that has the feature off for this user,
    // and its link is not kept for whoever signs in next.
    if (user.teams !== true) {
      forgetToken();
      return;
    }
    if (!token) {
      setState({ kind: "missing" });
      return;
    }
    let current = true;
    apiFetch<OrgInvitePreviewResponse>("/api/orgs/invites/preview", jsonBody({ token }))
      .then((preview) => {
        if (current) setState({ kind: "ready", preview });
      })
      .catch((err) => {
        const code = apiErrorCode(err);
        if (code === null) captureClientError(err, { scope: "org.invite.preview" });
        // A link that can never work is not kept for the next visit.
        if (code !== null && TERMINAL_INVITE_CODES.has(code)) forgetToken();
        if (current) setState({ kind: "error", key: orgErrorKey(err) });
      });
    return () => {
      current = false;
    };
  }, [token, user]);

  const accept = async (orgName: string) => {
    const ok = await run(() =>
      apiFetch("/api/orgs/invites/accept", jsonBody({ token, shareFreeBusy: share })).catch(
        (err: unknown) => {
          const code = apiErrorCode(err);
          if (code !== null && TERMINAL_INVITE_CODES.has(code)) forgetToken();
          throw err;
        },
      ),
    );
    if (!ok) return;
    forgetToken();
    setState({ kind: "joined", orgName });
  };

  if (user && user.teams !== true) {
    return <p className="text-role-body text-ink-mid">{t("settings.team.unavailable")}</p>;
  }
  if (state.kind === "loading") {
    return (
      <p role="status" className="text-role-body text-ink-dim">
        {t("teamInvite.loading")}
      </p>
    );
  }
  if (state.kind === "missing")
    return <p className="text-role-body text-ink-mid">{t("teamInvite.missing")}</p>;
  if (state.kind === "error")
    return (
      <p role="alert" className="text-role-body text-ink-mid">
        {t(state.key)}
      </p>
    );
  if (state.kind === "joined") {
    return (
      <div className="space-y-3">
        <p role="status" className="text-role-body text-ink">
          {t("teamInvite.joined", { org: state.orgName })}
        </p>
        <Link className={`${PRIMARY_BTN} min-h-11`} href="/settings/team">
          {t("teamInvite.openSettings")}
        </Link>
      </div>
    );
  }

  const { preview } = state;
  const blocked = !preview.emailMatches || !preview.emailVerified;
  return (
    <div className="space-y-4">
      <h1 className="text-role-page font-semibold text-ink">
        {t("teamInvite.title", { org: preview.orgName })}
      </h1>
      <p className="text-role-body text-ink-mid">
        {t("teamInvite.body", { org: preview.orgName })}
      </p>
      {!preview.emailMatches && (
        <p role="alert" className="text-role-body text-ink-mid">
          {t("settings.org.error.INVITE_EMAIL_MISMATCH")}
        </p>
      )}
      {preview.emailMatches && !preview.emailVerified && (
        <p role="alert" className="text-role-body text-ink-mid">
          {t("settings.org.error.EMAIL_NOT_VERIFIED")}
        </p>
      )}
      {!blocked && (
        <>
          <div className="space-y-1">
            <Switch checked={share} label={t("settings.org.freeBusy.label")} onChange={setShare} />
            <p className="text-role-caption text-ink-dim">{t("settings.org.freeBusy.hint")}</p>
          </div>
          <Button loading={busy} disabled={busy} onClick={() => void accept(preview.orgName)}>
            {t("teamInvite.accept", { org: preview.orgName })}
          </Button>
        </>
      )}
      {errorKey && (
        <p role="alert" className="text-role-caption text-ink-mid">
          {t(errorKey)}
        </p>
      )}
    </div>
  );
}

export default function TeamInvitePage() {
  // Read before AuthGuard can send a signed-out visitor to /login, which
  // keeps the path and query but not the fragment.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setToken(captureToken());
  }, []);
  if (token === undefined) return null;
  return (
    <AuthGuard>
      <main className={`${PAGE_SHELL} max-w-xl`}>
        <InviteAccept token={token} />
      </main>
    </AuthGuard>
  );
}
