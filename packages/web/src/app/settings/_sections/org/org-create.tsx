"use client";

import { useState } from "react";
import Button from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { jsonBody, useOrgAction } from "./use-org";

/** No organization yet: what one is, and a name to create it with. */
export function OrgCreate({ onCreated }: { onCreated: () => Promise<void> }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const { busy, errorKey, run } = useOrgAction();

  const create = async () => {
    const ok = await run(() => apiFetch("/api/orgs", jsonBody({ name: name.trim() })));
    if (ok) await onCreated();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <p className="text-role-body text-ink-mid">{t("settings.org.intro")}</p>
      <Input
        id="org-name"
        label={t("settings.org.create.name")}
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy} disabled={busy || !name.trim()}>
          {t("settings.org.create.button")}
        </Button>
        {errorKey && (
          <p role="alert" className="text-role-caption text-ink-mid">
            {t(errorKey)}
          </p>
        )}
      </div>
    </form>
  );
}
