/**
 * One row of Settings › MCP API keys.
 *
 * Two render paths on purpose. Without write tools (`writeTools` false — the
 * server has not reported `writeToolsAvailable`) the row is exactly the pre-A3
 * markup, so the feature-flag-off page is unchanged; e2e/api-keys-permission.spec.ts
 * pins it against the captured pre-A3 HTML. With write tools it adds the key's
 * permission and, for a read-write key, the Agent activity disclosure.
 */

import type { ApiKeyWire } from "@klorn/contract";
import { useId, useState } from "react";
import { permissionChipClasses, permissionLabelKey } from "../lib/api-key-ui";
import { useT } from "../lib/i18n";
import { ApiKeyActivityPanel, ApiKeyActivityToggle } from "./api-key-activity";

const NAME_CELL = "min-w-0 flex-1 truncate text-sm text-ink";
const NAME_CELL_WRAPPING = "min-w-32 flex-1 truncate text-sm text-ink";
const REVOKE = "text-xs text-ink-dim hover:text-state-danger-ink";
const REVOKE_TALL =
  "inline-flex min-h-11 items-center px-2 text-xs text-ink-dim hover:text-state-danger-ink focus-ring";
const REVOKED_CHIP =
  "rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-ink-dim";

interface Props {
  apiKey: ApiKeyWire;
  writeTools: boolean;
  onRevoke: (id: string, name: string) => void;
}

function NameCell({ apiKey, className }: { apiKey: ApiKeyWire; className: string }) {
  return (
    <span className={className}>
      {apiKey.name}
      <span className="ml-2 font-mono text-xs text-ink-dim">{apiKey.prefix}…</span>
    </span>
  );
}

export function ApiKeyRow({ apiKey, writeTools, onRevoke }: Props) {
  const { t } = useT();
  const panelId = useId();
  const [open, setOpen] = useState(false);

  const revokeControl = apiKey.revoked ? (
    <span className={REVOKED_CHIP}>{t("settings.apiKeys.revokedChip")}</span>
  ) : (
    <button
      type="button"
      onClick={() => onRevoke(apiKey.id, apiKey.name)}
      className={writeTools ? REVOKE_TALL : REVOKE}
    >
      {t("settings.apiKeys.revoke")}
    </button>
  );

  if (!writeTools) {
    return (
      <li className="flex items-center gap-2 py-2">
        <NameCell apiKey={apiKey} className={NAME_CELL} />
        {revokeControl}
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-x-2 py-1">
      <NameCell apiKey={apiKey} className={NAME_CELL_WRAPPING} />
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${permissionChipClasses(apiKey.permission)}`}
      >
        {t(permissionLabelKey(apiKey.permission))}
      </span>
      {apiKey.permission === "read_write" && (
        <ApiKeyActivityToggle
          keyName={apiKey.name}
          open={open}
          panelId={panelId}
          onToggle={() => setOpen((current) => !current)}
        />
      )}
      {revokeControl}
      {open && apiKey.permission === "read_write" && (
        <ApiKeyActivityPanel id={panelId} keyId={apiKey.id} />
      )}
    </li>
  );
}
