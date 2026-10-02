/**
 * Settings › MCP API keys — machine credentials for the MCP endpoint
 * (POST /api/mcp). Create shows the raw key exactly once with a copy
 * affordance; the list carries display metadata only; revoke is a
 * timestamp, so revoked keys stay visible.
 *
 * Write tools (step A3): while GET /api/keys reports `writeToolsAvailable`, the
 * create form offers Read only / Read and write, each key shows its permission
 * and each read-write key can show its agent activity. Without that field the
 * section is exactly what it was before, including the create request body.
 */

import type {
  ApiKeyPermissionWire,
  ApiKeysListResponse,
  CreateApiKeyResponse,
} from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { buttonClasses } from "../lib/api-key-controls";
import { DEFAULT_API_KEY_PERMISSION } from "../lib/api-key-ui";
import { useT } from "../lib/i18n";
import { captureClientError } from "../lib/sentry";
import { ApiKeyCreateForm } from "./api-key-create-form";
import { ApiKeyRow } from "./api-key-row";
import { useConfirm } from "./confirm-dialog";
import { useToast } from "./toast";

export function ApiKeysSection() {
  const { t } = useT();
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [keys, setKeys] = useState<ApiKeysListResponse["keys"]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<CreateApiKeyResponse | null>(null);
  const [writeTools, setWriteTools] = useState(false);
  const [permission, setPermission] = useState<ApiKeyPermissionWire>(DEFAULT_API_KEY_PERMISSION);

  const load = useCallback(() => {
    apiFetch<ApiKeysListResponse>("/api/keys")
      .then((d) => {
        setKeys(d.keys);
        setWriteTools(d.writeToolsAvailable === true);
      })
      .catch((err) => captureClientError(err, { scope: "settings.api-keys-list" }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await apiFetch<CreateApiKeyResponse>("/api/keys", {
        method: "POST",
        body: JSON.stringify(writeTools ? { name, permission } : { name }),
      });
      setFreshKey(res);
      setName("");
      // A read-write choice never carries over silently to the next key.
      setPermission(DEFAULT_API_KEY_PERMISSION);
      load();
    } catch (err) {
      captureClientError(err, { scope: "settings.api-keys-create" });
      toast(t("settings.apiKeys.createFailed"), "error");
    } finally {
      setCreating(false);
    }
  };

  const copyFreshKey = async () => {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey.key);
      toast(t("settings.apiKeys.copied"), "success");
    } catch {
      // Clipboard can be blocked (permissions, non-secure context) — the key
      // is still on screen to copy by hand, so no error state needed.
    }
  };

  const revoke = async (id: string, keyName: string) => {
    const ok = await confirm({
      title: t("settings.apiKeys.revokeConfirm.title"),
      message: t("settings.apiKeys.revokeConfirm.message", { name: keyName }),
      danger: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/keys/${id}`, { method: "DELETE" });
      toast(t("settings.apiKeys.revokedToast"), "success");
      load();
    } catch (err) {
      captureClientError(err, { scope: "settings.api-keys-revoke" });
      toast(t("settings.apiKeys.revokeFailed"), "error");
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-mid">{t("settings.apiKeys.intro")}</p>

      <ApiKeyCreateForm
        name={name}
        onNameChange={setName}
        creating={creating}
        onCreate={create}
        writeTools={writeTools}
        permission={permission}
        onPermissionChange={setPermission}
      />

      {freshKey && (
        <div className="space-y-2 rounded-xl border border-line bg-surface-raised p-3">
          <p className="text-xs font-medium text-ink-mid">{t("settings.apiKeys.createdNotice")}</p>
          <code className="block select-all break-all rounded-lg bg-surface-panel px-2 py-1.5 text-xs text-ink">
            {freshKey.key}
          </code>
          <div className="flex gap-2">
            <button type="button" onClick={copyFreshKey} className={buttonClasses(writeTools)}>
              {t("settings.apiKeys.copy")}
            </button>
            <button
              type="button"
              onClick={() => setFreshKey(null)}
              className={buttonClasses(writeTools)}
            >
              {t("settings.apiKeys.dismiss")}
            </button>
          </div>
        </div>
      )}

      {keys.length === 0 ? (
        <p className="text-sm text-ink-dim">{t("settings.apiKeys.empty")}</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {keys.map((key) => (
            <ApiKeyRow key={key.id} apiKey={key} writeTools={writeTools} onRevoke={revoke} />
          ))}
        </ul>
      )}
    </div>
  );
}
