"use client";

import type { OrgInvitesResponse, OrgInviteWire } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import Button from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { captureClientError } from "../../../../lib/sentry";
import { jsonBody, useOrgAction } from "./use-org";

/** Owner only: invite by email, and the pending invites with a revoke each. */
export function OrgInvites() {
  const { t, locale } = useT();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [invites, setInvites] = useState<OrgInviteWire[]>([]);
  const { busy, errorKey, run } = useOrgAction();

  const load = useCallback(async () => {
    try {
      setInvites((await apiFetch<OrgInvitesResponse>("/api/orgs/current/invites")).invites);
    } catch (err) {
      captureClientError(err, { scope: "org.invites" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    const address = email.trim();
    setSentTo(null);
    const ok = await run(() => apiFetch("/api/orgs/current/invites", jsonBody({ email: address })));
    if (!ok) return;
    setSentTo(address);
    setEmail("");
    await load();
  };
  const revoke = async (invite: OrgInviteWire) => {
    const ok = await run(() =>
      apiFetch(`/api/orgs/current/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE" }),
    );
    if (ok) await load();
  };
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale);

  return (
    <section aria-labelledby="org-invite-title" className="space-y-3">
      <h3 id="org-invite-title" className="text-role-label font-semibold text-ink">
        {t("settings.org.invite.title")}
      </h3>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            id="org-invite-email"
            type="email"
            autoComplete="off"
            label={t("settings.org.invite.label")}
            placeholder={t("settings.org.invite.placeholder")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button type="submit" loading={busy} disabled={busy || !email.trim()}>
          {t("settings.org.invite.button")}
        </Button>
      </form>
      <div aria-live="polite">
        {sentTo && (
          <p className="text-role-caption text-ink-mid">
            {t("settings.org.invite.sent", { email: sentTo })}
          </p>
        )}
        {errorKey && (
          <p role="alert" className="text-role-caption text-ink-mid">
            {t(errorKey)}
          </p>
        )}
      </div>
      {invites.length > 0 && (
        <ul aria-label={t("settings.org.invite.pending")} className="divide-y divide-line/70">
          {invites.map((invite) => (
            <li key={invite.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-role-body text-ink">{invite.email}</p>
                <p className="text-role-caption text-ink-dim">
                  {t("settings.org.invite.expires", { date: date(invite.expiresAt) })}
                </p>
              </div>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => revoke(invite)}>
                {t("settings.org.invite.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
