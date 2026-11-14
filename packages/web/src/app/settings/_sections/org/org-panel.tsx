"use client";

import type { OrgMeWire, OrgTransparencyResponse, OrgWire } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import Button from "../../../../components/ui/button";
import Switch from "../../../../components/ui/switch";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { captureClientError } from "../../../../lib/sentry";
import { PANEL, SECTION_TITLE } from "../shared";
import { LoadFailed } from "./load-failed";
import { isOwner } from "./model";
import { OrgCeilings, OrgSeats } from "./org-admin";
import { OrgCreate } from "./org-create";
import { OrgInvites } from "./org-invites";
import { OrgMembers } from "./org-members";
import { OrgTransparency } from "./org-transparency";
import { jsonBody, useOrgAction, useOrgView } from "./use-org";

/** Settings → Team, Klorn Teams: the organization, or the form that creates one. */
export function OrgPanel() {
  const { t } = useT();
  const { view, failed, reload } = useOrgView();

  let body: React.ReactNode;
  if (view === undefined) {
    body = failed ? (
      <LoadFailed onRetry={() => void reload()} />
    ) : (
      <p role="status" className="text-role-body text-ink-dim">
        {t("settings.org.loading")}
      </p>
    );
  } else if (view.org === null) body = <OrgCreate onCreated={reload} />;
  else body = <OrgDetail org={view.org} me={view.me} reload={reload} />;

  return (
    <section className="mb-8" aria-labelledby="org-title">
      <h2 id="org-title" className={SECTION_TITLE}>
        {t("settings.org.title")}
      </h2>
      <div className={`${PANEL} space-y-4 p-5`}>
        {failed && view !== undefined && <LoadFailed onRetry={() => void reload()} />}
        {body}
      </div>
    </section>
  );
}

function OrgDetail({
  org,
  me,
  reload,
}: {
  org: OrgWire;
  me: OrgMeWire;
  reload: () => Promise<void>;
}) {
  const { t } = useT();
  const owner = isOwner(me);
  const [transparency, setTransparency] = useState<OrgTransparencyResponse | null>(null);
  const [transparencyFailed, setTransparencyFailed] = useState(false);
  const { busy, errorKey, run } = useOrgAction();

  const loadTransparency = useCallback(async () => {
    try {
      setTransparency(await apiFetch<OrgTransparencyResponse>("/api/orgs/current/transparency"));
      setTransparencyFailed(false);
    } catch (err) {
      captureClientError(err, { scope: "org.transparency" });
      setTransparencyFailed(true);
    }
  }, []);
  useEffect(() => {
    void loadTransparency();
  }, [loadTransparency]);

  const refresh = async () => {
    await Promise.all([reload(), loadTransparency()]);
  };
  const share = async (next: boolean) => {
    const ok = await run(() =>
      apiFetch("/api/orgs/current/availability-grant", {
        method: "PUT",
        body: JSON.stringify({ shareFreeBusy: next }),
      }),
    );
    if (ok) await refresh();
  };
  const leave = async () => {
    if (!window.confirm(t("settings.org.leave.confirm", { org: org.name }))) return;
    const ok = await run(() => apiFetch("/api/orgs/current/leave", jsonBody({})));
    if (ok) await reload();
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-role-title font-semibold text-ink">{org.name}</p>
        <p className="text-role-caption text-ink-dim">
          {t(owner ? "settings.org.role.owner" : "settings.org.role.member")}
        </p>
      </div>
      <div className="space-y-1">
        <Switch
          checked={me.sharesFreeBusy}
          disabled={busy}
          label={t("settings.org.freeBusy.label")}
          onChange={(next) => void share(next)}
        />
        <p className="text-role-caption text-ink-dim">{t("settings.org.freeBusy.hint")}</p>
      </div>
      <OrgMembers owner={owner} onChanged={refresh} />
      {owner && <OrgInvites />}
      {owner && <OrgCeilings org={org} onChanged={refresh} />}
      <OrgSeats org={org} owner={owner} price={transparency?.seatPrice ?? null} />
      {transparency && <OrgTransparency data={transparency} />}
      {transparencyFailed && <LoadFailed onRetry={() => void loadTransparency()} />}
      <div className="space-y-2 border-t border-line/70 pt-4">
        <Button variant="secondary" disabled={busy} onClick={() => void leave()}>
          {t("settings.org.leave.button")}
        </Button>
        {owner && (
          <p className="text-role-caption text-ink-dim">{t("settings.org.leave.ownerHint")}</p>
        )}
        {errorKey && (
          <p role="alert" className="text-role-caption text-ink-mid">
            {t(errorKey)}
          </p>
        )}
      </div>
    </div>
  );
}
