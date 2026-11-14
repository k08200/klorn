"use client";

import type { OrgMembersResponse, OrgMemberWire } from "@klorn/contract";
import { useRef } from "react";
import Button from "../../../../components/ui/button";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { LoadFailed } from "./load-failed";
import { ROLE_KEYS } from "./model";
import { jsonBody, useOrgAction, useOrgList } from "./use-org";

const pickMembers = (body: unknown) => (body as OrgMembersResponse).members;

/** The roster: everyone sees it; the owner can remove a member or hand over ownership. */
export function OrgMembers({
  owner,
  onChanged,
}: {
  owner: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useT();
  const {
    rows: members,
    failed,
    load,
  } = useOrgList("/api/orgs/current/members", pickMembers, "org.members");
  const { busy, errorKey, run } = useOrgAction();
  const heading = useRef<HTMLHeadingElement>(null);

  const label = (member: OrgMemberWire) => member.name || member.email;
  const change = async (work: () => Promise<unknown>) => {
    const ok = await run(work);
    if (!ok) return;
    await Promise.all([load(), onChanged()]);
    // The row's button is gone: keep keyboard focus in the section.
    heading.current?.focus();
  };
  const remove = (member: OrgMemberWire) => {
    if (!window.confirm(t("settings.org.members.confirmRemove", { name: label(member) }))) return;
    void change(() =>
      apiFetch(`/api/orgs/current/members/${encodeURIComponent(member.membershipId)}`, {
        method: "DELETE",
      }),
    );
  };
  const transfer = (member: OrgMemberWire) => {
    if (!window.confirm(t("settings.org.members.confirmTransfer", { name: label(member) }))) return;
    void change(() =>
      apiFetch("/api/orgs/current/transfer", jsonBody({ membershipId: member.membershipId })),
    );
  };

  return (
    <section aria-labelledby="org-members-title" className="space-y-3">
      <h3
        id="org-members-title"
        ref={heading}
        tabIndex={-1}
        className="text-role-label font-semibold text-ink focus:outline-none"
      >
        {t("settings.org.members.title")}
      </h3>
      {failed && <LoadFailed onRetry={() => void load()} />}
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
                  aria-label={`${t("settings.org.members.makeOwner")}: ${label(member)}`}
                  onClick={() => transfer(member)}
                >
                  {t("settings.org.members.makeOwner")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  aria-label={`${t("settings.org.members.remove")}: ${label(member)}`}
                  onClick={() => remove(member)}
                >
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
