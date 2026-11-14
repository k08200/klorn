"use client";

import type { OrgMembersResponse, OrgMemberWire } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import Button from "../../../../components/ui/button";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { captureClientError } from "../../../../lib/sentry";
import { ROLE_KEYS } from "./model";
import { jsonBody, useOrgAction } from "./use-org";

/** The roster: everyone sees it; the owner can remove a member or hand over ownership. */
export function OrgMembers({
  owner,
  onChanged,
}: {
  owner: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useT();
  const [members, setMembers] = useState<OrgMemberWire[]>([]);
  const { busy, errorKey, run } = useOrgAction();

  const load = useCallback(async () => {
    try {
      setMembers((await apiFetch<OrgMembersResponse>("/api/orgs/current/members")).members);
    } catch (err) {
      captureClientError(err, { scope: "org.members" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const label = (member: OrgMemberWire) => member.name || member.email;
  const remove = async (member: OrgMemberWire) => {
    if (!window.confirm(t("settings.org.members.confirmRemove", { name: label(member) }))) return;
    const ok = await run(() =>
      apiFetch(`/api/orgs/current/members/${encodeURIComponent(member.membershipId)}`, {
        method: "DELETE",
      }),
    );
    if (ok) await Promise.all([load(), onChanged()]);
  };
  const transfer = async (member: OrgMemberWire) => {
    if (!window.confirm(t("settings.org.members.confirmTransfer", { name: label(member) }))) return;
    const ok = await run(() =>
      apiFetch("/api/orgs/current/transfer", jsonBody({ membershipId: member.membershipId })),
    );
    if (ok) await Promise.all([load(), onChanged()]);
  };

  return (
    <section aria-labelledby="org-members-title" className="space-y-3">
      <h3 id="org-members-title" className="text-role-label font-semibold text-ink">
        {t("settings.org.members.title")}
      </h3>
      <ul className="divide-y divide-line/70">
        {members.map((member) => (
          <li key={member.membershipId} className="flex flex-wrap items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-role-body text-ink">
                {label(member)}
                {member.isYou && (
                  <span className="text-ink-dim"> {t("settings.org.members.you")}</span>
                )}
              </p>
              <p className="truncate text-role-caption text-ink-dim">
                {[
                  t(ROLE_KEYS[member.role]),
                  t(
                    member.seated ? "settings.org.members.seated" : "settings.org.members.unseated",
                  ),
                  member.sharesFreeBusy ? t("settings.org.members.sharesFreeBusy") : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {owner && member.role === "MEMBER" && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => transfer(member)}
                >
                  {t("settings.org.members.makeOwner")}
                </Button>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => remove(member)}>
                  {t("settings.org.members.remove")}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {errorKey && (
        <p role="alert" className="text-role-caption text-ink-mid">
          {t(errorKey)}
        </p>
      )}
    </section>
  );
}
